import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Author, LinkRef, MediaItem } from './types.js';

export interface Extracted {
  title?: string;
  text: string;
  excerpt?: string;
  lang?: string;
  author?: Author;
  publishedAt?: string;
  updatedAt?: string;
  media: MediaItem[];
  links: LinkRef[];
  tags: string[];
  /** Site name from OpenGraph, useful for attribution. */
  siteName?: string;
  /** How we got the text — "readability" is the good path. */
  method: 'readability' | 'selector' | 'main-region' | 'body' | 'jsonld';
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});

// Keep tables — they are often the actual payload on docs and data pages,
// and Turndown drops them by default.
turndown.addRule('tables', {
  filter: ['table'],
  replacement: (_content, node) => mdTable(node as unknown as HTMLTableElement),
});
turndown.addRule('stripJunk', {
  filter: ['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button'] as unknown as TurndownService.Filter,
  replacement: () => '',
});
// Preserve the language hint on fenced code blocks.
turndown.addRule('fencedCode', {
  filter: (node) => node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
  replacement: (_c, node) => {
    const code = (node as HTMLElement).firstChild as HTMLElement;
    const cls = code.getAttribute?.('class') ?? '';
    const lang =
      code.getAttribute?.('data-lang') ??
      /language-([\w+-]+)/.exec(cls)?.[1] ?? /lang-([\w+-]+)/.exec(cls)?.[1] ?? '';
    return `\n\n\`\`\`${lang}\n${code.textContent ?? ''}\n\`\`\`\n\n`;
  },
});

function mdTable(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const cells = (r: Element) =>
    Array.from(r.querySelectorAll('th,td')).map((c) =>
      (c.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
    );
  const header = cells(rows[0]!);
  if (header.length === 0) return '';
  const body = rows.slice(1).map(cells).filter((r) => r.length > 0);
  const out = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.concat(Array(Math.max(0, header.length - r.length)).fill('')).slice(0, header.length).join(' | ')} |`),
  ];
  return `\n\n${out.join('\n')}\n\n`;
}

/** Clutter that survives Readability on some sites. */
const NOISE_SELECTORS = [
  'nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]',
  '[role="complementary"]', '.advertisement', '.ad', '#cookie-banner', '.cookie-consent',
  '.newsletter-signup', '.social-share', '.related-posts', '.sidebar', '[aria-hidden="true"]',
];

export interface ExtractOptions {
  /** CSS selector to extract instead of running Readability. */
  selector?: string;
  /** Keep the whole body rather than finding the article. */
  full?: boolean;
  /** Max characters in the output text. 0 = unlimited. */
  maxChars?: number;
  /** Include a links list in the result. Default true. */
  collectLinks?: boolean;
}

/**
 * HTML → clean Markdown + metadata. Tries, in order: an explicit selector,
 * Mozilla Readability, then the whole body. Metadata is merged from
 * OpenGraph, Twitter cards, JSON-LD and plain meta tags.
 */
export function extractFromHtml(html: string, baseUrl: string, opts: ExtractOptions = {}): Extracted {
  // Bot walls often answer with an empty body; parse something valid rather
  // than crash, and let the caller see "no text" and escalate.
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(html);
  prepare(document, baseUrl);
  const meta = readMetadata(document, baseUrl);

  let contentEl: Element | null = null;
  let method: Extracted['method'] = 'body';

  if (opts.selector) {
    contentEl = document.querySelector(opts.selector);
    if (!contentEl) throw new Error(`Selector "${opts.selector}" matched nothing on ${baseUrl}`);
    method = 'selector';
  } else if (!opts.full) {
    try {
      // Readability mutates the document, so parse a second copy for it.
      const { document: clone } = parseHTML(html);
      if (!clone.documentElement) throw new Error('empty document');
      prepare(clone, baseUrl);
      const article = new Readability(clone as unknown as Document, {
        charThreshold: 200,
        keepClasses: false,
      }).parse();
      const kept = (article?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
      // Guard: Readability sometimes keeps the headings and throws away the
      // body (e.g. help-centre layouts). If the page's own main region holds
      // far more text than Readability kept, trust the page instead.
      const region = mainRegion(document);
      const regionLen = region ? visibleTextLength(region) : 0;
      const readabilityLostIt = regionLen > 1200 && kept < regionLen * 0.4;
      if (article?.content && kept > 180 && !readabilityLostIt) {
        const { document: frag } = parseHTML(`<div id="__scour">${article.content}</div>`);
        contentEl = frag.querySelector('#__scour');
        method = 'readability';
        meta.title ??= article.title ?? undefined;
        meta.excerpt ??= article.excerpt ?? undefined;
        meta.siteName ??= article.siteName ?? undefined;
        if (article.byline && !meta.author) meta.author = { name: article.byline.trim() };
      }
    } catch {
      // Readability is best-effort; falling through to body is fine.
    }
  }

  if (!contentEl) {
    const region = mainRegion(document);
    contentEl = region ?? document.body;
    if (region) method = 'main-region';
    if (contentEl) {
      for (const sel of NOISE_SELECTORS) {
        for (const el of Array.from(contentEl.querySelectorAll(sel))) el.remove();
      }
    }
  }

  // Links come from the whole page, navigation included: that is how crawl and
  // map discover the rest of a site, and what API clients expect from "links".
  const links = opts.collectLinks === false ? [] : collectLinks(document.body ?? contentEl, baseUrl);
  const media = collectMedia(contentEl ?? document.body, baseUrl, meta);

  let text = contentEl ? turndown.turndown((contentEl as HTMLElement).innerHTML ?? '') : '';
  text = tidy(text);
  if (opts.maxChars && text.length > opts.maxChars) {
    text = `${text.slice(0, opts.maxChars)}\n\n…[truncated at ${opts.maxChars} chars]`;
  }

  return { ...meta, text, media, links, method };
}

/**
 * Make a parsed page self-contained before extraction: every link and image
 * absolute (agents can't follow "/notes"), and code-block languages moved to a
 * data attribute so they survive Readability's class stripping.
 */
function prepare(document: Document, baseUrl: string): void {
  const base = safeUrl(baseUrl);
  if (!base) return;
  for (const [sel, attr] of [['a[href]', 'href'], ['img[src]', 'src'], ['img[data-src]', 'data-src'], ['source[src]', 'src']] as const) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const v = el.getAttribute(attr);
      if (!v || v.startsWith('#') || /^(data|javascript|mailto):/i.test(v)) continue;
      const abs = safeUrl(v, base);
      if (abs) el.setAttribute(attr, abs.href);
    }
  }
  for (const el of Array.from(document.querySelectorAll('pre code[class], pre[class]'))) {
    const cls = el.getAttribute('class') ?? '';
    const lang = /(?:language|lang)-([\w+-]+)/.exec(cls)?.[1];
    if (!lang) continue;
    const code = el.tagName === 'PRE' ? el.querySelector('code') ?? el : el;
    code.setAttribute('data-lang', lang);
  }
}

/** The page's own idea of its main content, before any heuristics. */
function mainRegion(document: Document): Element | null {
  return (
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.querySelector('article') ??
    null
  );
}

/** Text length of an element, ignoring scripts, styles and obvious chrome. */
function visibleTextLength(el: Element): number {
  const clone = el.cloneNode(true) as Element;
  for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', '[aria-hidden="true"]']) {
    for (const n of Array.from(clone.querySelectorAll(sel))) n.remove();
  }
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/**
 * Characters of real prose: drops headings, link-only lines and bare list
 * markers. A page that is all headings and nav has near-zero prose even when
 * its Markdown looks long — that is the "metadata, not content" failure.
 */
export function proseLength(md: string): number {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^[-*]?\s*\[[^\]]*\]\([^)]*\)\s*$/.test(l) && !/^[-*|]+$/.test(l))
    .join(' ').length;
}

export interface ServedMarkdown {
  text: string;
  jsonLd?: { headline?: string; description?: string; datePublished?: string; dateModified?: string; author?: string };
}

/**
 * Clean Markdown a site served us directly (content negotiation). Converters
 * like Cloudflare's translate the *whole* page, so strip what Readability
 * would have: raw HTML widgets, link farms (nav, share bars, footers),
 * repeated lines and the JSON-LD blob, which we mine for metadata first.
 */
export function cleanServedMarkdown(md: string): ServedMarkdown {
  let jsonLd: ServedMarkdown['jsonLd'];
  let text = md.replace(/```json\n(\{[\s\S]*?"@context"[\s\S]*?\})\n```/g, (_m, raw: string) => {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const a = j.author as { name?: string } | { name?: string }[] | string | undefined;
      jsonLd ??= {
        headline: typeof j.headline === 'string' ? j.headline : undefined,
        description: typeof j.description === 'string' ? j.description : undefined,
        datePublished: typeof j.datePublished === 'string' ? j.datePublished : undefined,
        dateModified: typeof j.dateModified === 'string' ? j.dateModified : undefined,
        author: typeof a === 'string' ? a : Array.isArray(a) ? a[0]?.name : a?.name,
      };
    } catch {
      // not valid JSON-LD; drop it anyway
    }
    return '';
  });
  // Raw HTML widgets the converter passed through (language pickers, menus).
  text = text.replace(/<details>[\s\S]*?<\/details>/g, '');

  const out: string[] = [];
  let prev = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^<\/?[a-z][^>]*>$/i.test(t)) continue; // stray HTML tag lines
    if (/^!\[\]\(\)$/.test(t)) continue; // empty image placeholders
    const links = t.match(/\[[^\]]*\]\([^)]*\)/g) ?? [];
    if (links.length >= 3) {
      const linkChars = links.join('').length;
      if (linkChars / t.length > 0.7) continue; // nav / share / footer link farm
    }
    if (/opens in a new tab/i.test(t) && links.length >= 1 && t.replace(/\[[^\]]*\]\([^)]*\)/g, '').trim().length < 20) continue;
    if (t && t === prev) continue;
    out.push(line);
    if (t) prev = t;
  }
  // Footer chrome is a run of short lines after the last real paragraph
  // ("Subscribe", "Email address", theme toggles). Trim it when the tail has
  // no prose, lists or code of its own.
  let lastProse = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.trim().length >= 100) { lastProse = i; break; }
  }
  if (lastProse >= 0) {
    const tail = out.slice(lastProse + 1).map((l) => l.trim()).filter(Boolean);
    const substantive = tail.filter((l) => l.length >= 60 || /^([-*]|\d+\.)\s|^```|^\|/.test(l));
    if (tail.length >= 3 && substantive.length === 0) out.length = lastProse + 1;
  }
  return { text: tidy(out.join('\n')), jsonLd };
}

/** Collapse the whitespace soup Turndown leaves behind. */
export function tidy(md: string): string {
  return md
    // Nested bold tags (<strong><b>…</b></strong>) turn into ****text****.
    .replace(/\*{4,}(?=\S)([^*\n]+?)(?<=\S)\*{4,}/g, '**$1**')
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
    .trim();
}

function readMetadata(document: Document, baseUrl: string): Omit<Extracted, 'text' | 'media' | 'links' | 'method'> & { tags: string[] } {
  const m = (name: string): string | undefined => {
    const el =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`) ??
      document.querySelector(`meta[itemprop="${name}"]`);
    const v = el?.getAttribute('content')?.trim();
    return v || undefined;
  };

  const jsonld = readJsonLd(document);

  const authorName =
    m('author') ?? m('article:author') ?? m('twitter:creator') ??
    jsonld?.authorName ?? document.querySelector('[rel="author"]')?.textContent?.trim() ?? undefined;

  const tags = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('meta[property="article:tag"]'))) {
    const v = el.getAttribute('content')?.trim();
    if (v) tags.add(v);
  }
  for (const kw of (m('keywords') ?? '').split(',')) {
    const v = kw.trim();
    if (v && v.length < 40) tags.add(v);
  }

  return {
    title: (m('og:title') ?? m('twitter:title') ?? jsonld?.headline ?? document.querySelector('title')?.textContent ?? undefined)?.trim(),
    excerpt: (m('og:description') ?? m('description') ?? m('twitter:description') ?? jsonld?.description)?.trim(),
    lang: document.documentElement?.getAttribute('lang')?.slice(0, 5) ?? m('og:locale')?.slice(0, 5) ?? undefined,
    author: authorName ? { name: authorName.replace(/^@/, ''), handle: m('twitter:creator')?.replace(/^@/, '') } : undefined,
    publishedAt: normDate(m('article:published_time') ?? m('datePublished') ?? jsonld?.datePublished ?? document.querySelector('time[datetime]')?.getAttribute('datetime') ?? undefined),
    updatedAt: normDate(m('article:modified_time') ?? m('dateModified') ?? jsonld?.dateModified),
    siteName: m('og:site_name') ?? safeHost(baseUrl),
    tags: [...tags].slice(0, 20),
  };
}

interface JsonLdInfo {
  headline?: string;
  description?: string;
  datePublished?: string;
  dateModified?: string;
  authorName?: string;
}

function readJsonLd(document: Document): JsonLdInfo | undefined {
  for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed: unknown = JSON.parse(el.textContent ?? '');
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of nodes) {
        const n = raw as Record<string, unknown>;
        const graph = n['@graph'];
        const candidates = Array.isArray(graph) ? (graph as Record<string, unknown>[]) : [n];
        for (const c of candidates) {
          const type = String(c['@type'] ?? '');
          if (!/Article|BlogPosting|NewsArticle|WebPage|Report/i.test(type)) continue;
          const a = c.author as Record<string, unknown> | Record<string, unknown>[] | string | undefined;
          const authorName =
            typeof a === 'string' ? a
            : Array.isArray(a) ? (a[0]?.name as string | undefined)
            : (a?.name as string | undefined);
          return {
            headline: str(c.headline),
            description: str(c.description),
            datePublished: str(c.datePublished),
            dateModified: str(c.dateModified),
            authorName,
          };
        }
      }
    } catch {
      // Malformed JSON-LD is extremely common; ignore it.
    }
  }
  return undefined;
}

function collectLinks(root: Element, baseUrl: string): LinkRef[] {
  const base = safeUrl(baseUrl);
  const seen = new Set<string>();
  const out: LinkRef[] = [];
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    const abs = safeUrl(href, base);
    if (!abs || seen.has(abs.href)) continue;
    seen.add(abs.href);
    out.push({
      url: abs.href,
      text: (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined,
      external: base ? abs.host !== base.host : undefined,
    });
    if (out.length >= 300) break;
  }
  return out;
}

function collectMedia(root: Element, baseUrl: string, meta: { title?: string }): MediaItem[] {
  const base = safeUrl(baseUrl);
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  for (const img of Array.from(root.querySelectorAll('img[src], img[data-src]'))) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src || src.startsWith('data:')) continue;
    const abs = safeUrl(src, base);
    if (!abs || seen.has(abs.href)) continue;
    seen.add(abs.href);
    const w = Number(img.getAttribute('width')) || undefined;
    const h = Number(img.getAttribute('height')) || undefined;
    // Skip tracking pixels and spacer gifs.
    if (w && h && w <= 2 && h <= 2) continue;
    out.push({ type: 'image', url: abs.href, alt: img.getAttribute('alt') ?? undefined, width: w, height: h });
    if (out.length >= 50) break;
  }
  void meta;
  return out;
}

export function safeUrl(href: string, base?: URL | null): URL | null {
  try {
    return new URL(href, base ?? undefined);
  } catch {
    return null;
  }
}

function safeHost(u: string): string | undefined {
  return safeUrl(u)?.host;
}

export function normDate(v: string | number | undefined | null): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  // Bare seconds-since-epoch (Reddit, HN) vs. milliseconds.
  const n = typeof v === 'number' ? v : /^\d{9,13}$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Shorten a Markdown body to roughly N tokens (~4 chars/token), on a paragraph edge. */
export function clip(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n\n', maxChars);
  return `${text.slice(0, cut > maxChars * 0.6 ? cut : maxChars)}\n\n…[clipped to ~${maxTokens} tokens]`;
}
