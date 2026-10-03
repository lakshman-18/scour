import { cleanServedMarkdown, extractFromHtml, normDate, proseLength, tidy } from '../core/extract.js';
import { HttpError } from '../core/http.js';
import { PRICES } from '../core/budget.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
} from '../core/types.js';
import { makeDoc, prov, kindFromUrl } from './_helpers.js';
import { parseFeed } from './rss.js';
import { convertDocument, documentFormat } from '../core/documents.js';

/**
 * The universal fallback: works on any URL on the internet.
 *
 * Ladder: static HTTP → headless render → paid reader API.
 * We only climb when the cheaper tier produced something unusable, and
 * "unusable" is a measured judgement, not a guess (see `looksEmpty`).
 */
export const genericAdapter: Adapter = {
  name: 'web',
  priority: -100, // always last

  match(): boolean {
    return true;
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const maxTier = ctx.options.maxTier ?? Tier.Headless;
    const ao = (ctx.options.adapterOptions ?? {}) as { selector?: string; full?: boolean; maxChars?: number };
    const failures: string[] = [];

    // ---- Tier 2: plain HTTP -------------------------------------------
    if (maxTier >= Tier.Static) {
      try {
        const res = await ctx.http.get(url.href, {
          timeoutMs: ctx.options.timeoutMs,
          // Ask for Markdown first. Sites behind Cloudflare's "Markdown for
          // Agents" answer with clean Markdown (17-30x smaller in our tests);
          // everyone else ignores the preference and sends HTML as usual.
          headers: { Accept: MARKDOWN_FIRST, ...ctx.options.headers },
          proxy: ctx.options.proxy,
          allowStatus: [401, 403, 404, 410, 451],
        });

        const ct = res.headers['content-type'] ?? '';

        // PDFs and Word documents: convert locally to Markdown.
        const docFormat = res.status < 400 ? documentFormat(ct, res.url) : null;
        if (docFormat && res.raw?.length) {
          const conv = await convertDocument(res.raw, docFormat);
          if (conv.text.trim().length < 50) {
            throw new TierError(`This ${docFormat.toUpperCase()} has no extractable text (probably scanned images; OCR is not supported yet).`, Tier.Static, false);
          }
          return makeDoc({
            url: res.url, source: 'web', kind: 'file',
            title: conv.title ?? decodeURIComponent(url.pathname.split('/').pop() || url.host),
            text: conv.text,
            author: conv.author ? { name: conv.author } : undefined,
            publishedAt: conv.publishedAt,
            extra: { format: docFormat, pages: conv.pages },
            provenance: prov({ tier: Tier.Static, adapter: 'web', strategy: `${docFormat} → markdown`, finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
          });
        }

        if (res.status < 400 && /text\/markdown/i.test(ct) && !ao.selector) {
          const served = fromServedMarkdown(res.body, res.url, res.status, res.bytes, res.headers, ao);
          if (proseLength(served.text) >= 200) return served;
          failures.push('served markdown was too thin; falling back to HTML');
        }

        // Sniff feeds by content, not URL: plenty live at paths like /atom/everything/.
        if (res.status < 400 && isFeed(ct, res.body)) {
          const feed = parseFeed(res.body, res.url);
          feed.provenance = prov({ tier: Tier.Static, adapter: 'web', strategy: `sniffed ${feed.extra?.feedType ?? 'feed'}`, finalUrl: res.url, httpStatus: res.status, bytes: res.bytes });
          return feed;
        }
        // Other XML (sitemaps, APIs): return verbatim; HTML extraction would destroy it.
        if (res.status < 400 && /xml/.test(ct) && !/html/.test(ct)) {
          return makeDoc({
            url: res.url, source: 'web', kind: 'file',
            title: url.pathname.split('/').pop() || url.host,
            text: res.body,
            provenance: prov({ tier: Tier.Static, adapter: 'web', strategy: 'raw xml', finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
          });
        }

        // Non-HTML: hand back the bytes verbatim rather than mangling them.
        if (ct && !/text\/html|application\/xhtml|text\/plain|application\/xml|\+xml/.test(ct)) {
          if (/json|javascript/.test(ct)) {
            return makeDoc({
              url: res.url, source: 'web', kind: 'file',
              title: url.pathname.split('/').pop() || url.host,
              text: fenceJson(res.body),
              provenance: prov({ tier: Tier.Static, adapter: 'web', strategy: 'raw json', finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
            });
          }
          if (/^text\//.test(ct)) {
            return makeDoc({
              url: res.url, source: 'web', kind: 'file',
              title: url.pathname.split('/').pop() || url.host,
              text: res.body,
              provenance: prov({ tier: Tier.Static, adapter: 'web', strategy: 'raw text', finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
            });
          }
          throw new TierError(`Unsupported content-type "${ct}" — scour reads text, not binaries.`, Tier.Static, false);
        }

        if (res.status >= 400) {
          failures.push(`static: HTTP ${res.status}`);
          if (!isWorthRendering(res.status, res.body)) {
            throw new TierError(`HTTP ${res.status} for ${url.href}`, Tier.Static, false);
          }
        } else {
          const doc = buildFromHtml(res.body, res.url, res.status, res.bytes, Tier.Static, 'http', ao);
          if (!looksEmpty(doc, res.body)) return doc;
          failures.push(`static: extracted only ${doc.text.length} chars (page looks JS-rendered)`);
          ctx.log.debug(`${url.href}: thin static result, escalating`);
        }
      } catch (err) {
        if (err instanceof TierError && !err.retryable) throw err;
        const msg = err instanceof HttpError ? `HTTP ${err.status}` : (err as Error).message;
        failures.push(`static: ${msg}`);
        ctx.log.debug(`static fetch failed for ${url.href}: ${msg}`);
      }
    }

    // ---- Tier 3: headless browser --------------------------------------
    if (maxTier >= Tier.Headless) {
      try {
        const page = await ctx.render(url.href, {
          waitUntil: 'domcontentloaded',
          scroll: ao.full ? 3 : 1,
          waitForSelector: ao.selector,
        });
        const doc = buildFromHtml(page.html, page.url, page.status, page.html.length, Tier.Headless, 'playwright', ao);
        if (!looksEmpty(doc, page.html)) return doc;
        failures.push(`headless: rendered but still only ${doc.text.length} chars of text`);
      } catch (err) {
        failures.push(`headless: ${(err as Error).message}`);
        ctx.log.debug(`render failed for ${url.href}: ${(err as Error).message}`);
      }
    }

    // ---- Tier 4: paid reader APIs --------------------------------------
    if (maxTier >= Tier.Paid) {
      const paid = await tryPaidReaders(url, ctx, ao, failures);
      if (paid) return paid;
    }

    throw new TierError(
      `Could not read ${url.href}. Tried:\n  ${failures.join('\n  ')}\n` +
        (maxTier < Tier.Headless ? '  Hint: --max-tier headless enables JS rendering (still free).' : ''),
      maxTier,
      false,
    );
  },
};

function buildFromHtml(
  html: string,
  finalUrl: string,
  status: number,
  bytes: number,
  tier: Tier,
  strategy: string,
  ao: { selector?: string; full?: boolean; maxChars?: number },
): Document {
  const url = new URL(finalUrl);
  const ex = extractFromHtml(html, finalUrl, {
    selector: ao.selector,
    full: ao.full,
    maxChars: ao.maxChars,
  });
  return makeDoc({
    url: finalUrl,
    source: 'web',
    kind: ex.text.length > 400 ? 'article' : kindFromUrl(url),
    title: ex.title,
    text: ex.text,
    excerpt: ex.excerpt,
    lang: ex.lang,
    author: ex.author,
    publishedAt: ex.publishedAt,
    updatedAt: ex.updatedAt,
    media: ex.media,
    links: ex.links,
    tags: ex.tags,
    extra: { siteName: ex.siteName, extraction: ex.method },
    provenance: prov({ tier, adapter: 'web', strategy: `${strategy}+${ex.method}`, finalUrl, httpStatus: status, bytes }),
  });
}

/**
 * Is the extracted document too thin to be the real page? Being wrong in one
 * direction wastes a browser launch; being wrong in the other returns a
 * cookie banner as if it were an article. We bias toward escalating.
 */
function looksEmpty(doc: Document, html: string): boolean {
  const len = doc.text.trim().length;
  // Mostly headings and links with little prose: a shell, not the page.
  if (proseLength(doc.text) < 250 && html.length > 8_000) return true;
  if (len >= 500) return false;
  // Lots of HTML but almost no text is the classic SPA shell signature.
  if (html.length > 15_000 && len < 300) return true;
  if (len < 120) return true;
  return /enable javascript|requires javascript|loading…|please wait|checking your browser/i.test(doc.text);
}

/** 403/503 from a bot wall is worth a render; a real 404 is not. */
function isWorthRendering(status: number, body: string): boolean {
  if (status === 404 || status === 410) return false;
  if (status === 403 || status === 503 || status === 429) return true;
  return /cloudflare|just a moment|cf-browser-verification|captcha|datadome|perimeterx/i.test(body);
}

const MARKDOWN_FIRST = 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8';

/** Use the Markdown a site served us directly, reading its YAML front-matter. */
function fromServedMarkdown(
  body: string,
  finalUrl: string,
  status: number,
  bytes: number,
  headers: Record<string, string>,
  ao: { full?: boolean; maxChars?: number },
): Document {
  const maxChars = ao.maxChars;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, '').trim();
    }
  }
  const raw = tidy(fm ? body.slice(fm[0].length) : body)
    // Drop the accessibility skip-link most converted pages start with.
    .replace(/^\[Skip to (main )?content\]\(#[^)]*\)\s*/i, '');
  const cleaned = ao.full ? { text: raw, jsonLd: undefined } : cleanServedMarkdown(raw);
  let text = cleaned.text;
  if (maxChars && text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n…[truncated at ${maxChars} chars]`;
  const title = meta.title ?? /^#\s+(.+)$/m.exec(text)?.[1];
  const tokens = Number(headers['x-markdown-tokens']) || undefined;
  // Links come from the raw Markdown so navigation is kept for map/crawl,
  // even though it was trimmed from the readable text.
  const base = new URL(finalUrl);
  const seen = new Set<string>();
  const links: { url: string; text?: string; external?: boolean }[] = [];
  for (const m of raw.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
    try {
      const u = new URL(m[2]!, base);
      if (!/^https?:$/.test(u.protocol) || seen.has(u.href)) continue;
      seen.add(u.href);
      links.push({ url: u.href, text: m[1]?.trim() || undefined, external: u.host !== base.host });
    } catch {
      // skip malformed
    }
    if (links.length >= 300) break;
  }
  return makeDoc({
    url: finalUrl,
    source: 'web',
    kind: 'article',
    title,
    text,
    excerpt: meta.description ?? cleaned.jsonLd?.description,
    author: cleaned.jsonLd?.author ? { name: cleaned.jsonLd.author } : undefined,
    publishedAt: normDate(meta.date ?? meta.published ?? cleaned.jsonLd?.datePublished),
    updatedAt: normDate(cleaned.jsonLd?.dateModified),
    media: meta.image ? [{ type: 'image', url: meta.image }] : [],
    links,
    extra: { extraction: 'served-markdown', markdownTokens: tokens },
    provenance: prov({ tier: Tier.Static, adapter: 'web', strategy: 'markdown for agents', finalUrl, httpStatus: status, bytes }),
  });
}

function isFeed(ct: string, body: string): boolean {
  if (/rss|atom|feed\+json/i.test(ct)) return true;
  const head = body.slice(0, 600).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(head)) return true;
  return /json/.test(ct) && /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(head);
}

function fenceJson(body: string): string {
  try {
    return `\`\`\`json\n${JSON.stringify(JSON.parse(body), null, 2)}\n\`\`\``;
  } catch {
    return `\`\`\`\n${body}\n\`\`\``;
  }
}

/**
 * Paid escalation, cheapest first. Each provider is charged to the ledger
 * *before* the request, so a breach aborts instead of billing.
 */
async function tryPaidReaders(
  url: URL,
  ctx: AdapterContext,
  ao: { selector?: string; full?: boolean; maxChars?: number },
  failures: string[],
): Promise<Document | null> {
  const p = ctx.config.providers;

  // Jina Reader: free without a key (rate-limited), cheap with one.
  try {
    const price = p.jinaKey ? PRICES.jinaReader : 0;
    ctx.budget.charge(price, 'jina reader');
    const res = await ctx.http.get(`https://r.jina.ai/${url.href}`, {
      timeoutMs: Math.max(ctx.options.timeoutMs, 45_000),
      headers: {
        Accept: 'text/plain',
        'X-Return-Format': 'markdown',
        ...(p.jinaKey ? { Authorization: `Bearer ${p.jinaKey}` } : {}),
      },
    });
    const text = tidy(res.body);
    if (text.length > 200) {
      const title = /^Title:\s*(.+)$/m.exec(res.body)?.[1]?.trim();
      return makeDoc({
        url: url.href, source: 'web', kind: 'article', title,
        text: text.replace(/^Title:.*\n+/m, '').replace(/^URL Source:.*\n+/m, '').trim(),
        provenance: prov({ tier: Tier.Paid, adapter: 'web', strategy: 'jina reader', finalUrl: url.href, httpStatus: res.status, costUsd: price, bytes: res.bytes }),
      });
    }
    failures.push('jina: returned too little text');
  } catch (err) {
    failures.push(`jina: ${(err as Error).message}`);
  }

  // Firecrawl: best JS/anti-bot handling, needs a key.
  if (p.firecrawlKey) {
    try {
      ctx.budget.charge(PRICES.firecrawlScrape, 'firecrawl scrape');
      const res = await ctx.http.post(
        'https://api.firecrawl.dev/v1/scrape',
        { url: url.href, formats: ['markdown'], onlyMainContent: !ao.full },
        { headers: { Authorization: `Bearer ${p.firecrawlKey}` }, timeoutMs: 60_000 },
      );
      const json = JSON.parse(res.body) as { data?: { markdown?: string; metadata?: Record<string, unknown> } };
      const md = json.data?.markdown;
      if (md && md.length > 100) {
        const m = json.data?.metadata ?? {};
        return makeDoc({
          url: url.href, source: 'web', kind: 'article',
          title: (m.title as string) ?? (m.ogTitle as string),
          text: tidy(md),
          excerpt: (m.description as string) ?? undefined,
          provenance: prov({ tier: Tier.Paid, adapter: 'web', strategy: 'firecrawl', finalUrl: url.href, httpStatus: res.status, costUsd: PRICES.firecrawlScrape, bytes: res.bytes }),
        });
      }
      failures.push('firecrawl: empty markdown');
    } catch (err) {
      failures.push(`firecrawl: ${(err as Error).message}`);
    }
  }

  return null;
}
