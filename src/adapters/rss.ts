import * as cheerio from 'cheerio';
import { normDate, tidy, extractFromHtml } from '../core/extract.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document } from '../core/types.js';
import { makeDoc, prov, truncate } from './_helpers.js';

/**
 * RSS / Atom / JSON Feed.
 *
 * Matched by URL shape, but also used as a *rescue* path: the crawl and watch
 * workflows auto-discover a site's feed, which is far cheaper and more stable
 * than scraping its index page every few minutes.
 */
export const rssAdapter: Adapter = {
  name: 'rss',
  priority: 40,

  match(url: URL): boolean {
    return /(\/|\.)(rss|atom|feed)(\.xml|\.json)?\/?$/i.test(url.pathname) ||
      /\.(rss|atom)$/i.test(url.pathname) ||
      /[?&]format=(rss|atom)/i.test(url.search);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const res = await ctx.http.get(url.href, {
      timeoutMs: ctx.options.timeoutMs,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json;q=0.9, */*;q=0.8' },
    });
    const doc = parseFeed(res.body, res.url);
    doc.provenance = prov({
      tier: Tier.Native, adapter: 'rss', strategy: doc.extra?.feedType as string ?? 'feed',
      finalUrl: res.url, httpStatus: res.status, bytes: res.bytes,
    });
    return doc;
  },
};

/** Parse RSS 2.0, Atom or JSON Feed into the unified Document shape. */
export function parseFeed(body: string, feedUrl: string): Document {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, feedUrl);

  const $ = cheerio.load(body, { xmlMode: true });
  const isAtom = $('feed').length > 0;
  const channel = isAtom ? $('feed') : $('channel');
  if (channel.length === 0) throw new TierError(`${feedUrl} is not a recognisable RSS/Atom/JSON feed.`, Tier.Native, false);

  const feedTitle = channel.children('title').first().text().trim() || feedUrl;
  const feedDesc = (isAtom ? channel.children('subtitle') : channel.children('description')).first().text().trim();
  const siteLink = isAtom
    ? channel.children('link[rel="alternate"]').attr('href') ?? channel.children('link').first().attr('href')
    : channel.children('link').first().text().trim();

  const items: Document[] = [];
  $(isAtom ? 'entry' : 'item').each((_, el) => {
    const it = $(el);
    const link = isAtom
      ? it.children('link[rel="alternate"]').attr('href') ?? it.children('link').first().attr('href') ?? ''
      : it.children('link').first().text().trim() || it.children('guid').first().text().trim();
    const rawContent =
      it.children('content\\:encoded').first().text() ||
      it.children('content').first().text() ||
      it.children('description').first().text() ||
      it.children('summary').first().text();
    const text = looksHtml(rawContent) ? htmlToMd(rawContent, link || feedUrl) : tidy(rawContent);
    items.push(
      makeDoc({
        url: link || feedUrl,
        source: 'rss',
        nativeId: it.children('guid').first().text().trim() || it.children('id').first().text().trim() || undefined,
        kind: 'article',
        title: it.children('title').first().text().trim(),
        text,
        excerpt: truncate(text.replace(/\s+/g, ' '), 280),
        author:
          nonEmpty(it.children('author').children('name').text()) ??
          nonEmpty(it.children('dc\\:creator').text()) ??
          nonEmpty(it.children('author').text())
            ? {
                name: (
                  it.children('author').children('name').text() ||
                  it.children('dc\\:creator').text() ||
                  it.children('author').text()
                ).trim(),
              }
            : undefined,
        publishedAt: normDate(
          it.children('pubDate').text() || it.children('published').text() || it.children('updated').text() ||
          it.children('dc\\:date').text(),
        ),
        tags: it.children('category').map((__, c) => $(c).attr('term') ?? $(c).text()).get().filter(Boolean).slice(0, 10),
        provenance: prov({ tier: Tier.Native, adapter: 'rss', strategy: 'feed item', finalUrl: link || feedUrl }),
      }),
    );
  });

  const summary = [
    `# ${feedTitle}`,
    feedDesc ? `\n${feedDesc}` : '',
    siteLink ? `\n${siteLink}` : '',
    `\n${items.length} items\n`,
    ...items.map((i, n) => `${n + 1}. **[${i.title}](${i.url})** — ${i.publishedAt?.slice(0, 10) ?? '?'}${i.excerpt ? `\n   ${i.excerpt}` : ''}`),
  ];

  return makeDoc({
    url: feedUrl,
    source: 'rss',
    kind: 'listing',
    title: feedTitle,
    text: tidy(summary.join('\n')),
    excerpt: feedDesc || undefined,
    children: items,
    links: siteLink ? [{ url: siteLink }] : [],
    extra: { feedType: isAtom ? 'atom' : 'rss2', itemCount: items.length, siteLink },
    provenance: prov({ tier: Tier.Native, adapter: 'rss', strategy: isAtom ? 'atom' : 'rss2', finalUrl: feedUrl }),
  });
}

function parseJsonFeed(body: string, feedUrl: string): Document {
  const feed = JSON.parse(body) as {
    title?: string; description?: string; home_page_url?: string;
    items?: { id?: string; url?: string; title?: string; content_html?: string; content_text?: string; summary?: string; date_published?: string; authors?: { name: string }[]; tags?: string[] }[];
  };
  const items = (feed.items ?? []).map((i) => {
    const text = i.content_html ? htmlToMd(i.content_html, i.url ?? feedUrl) : tidy(i.content_text ?? i.summary ?? '');
    return makeDoc({
      url: i.url ?? feedUrl, source: 'rss', nativeId: i.id, kind: 'article',
      title: i.title, text, excerpt: truncate(text.replace(/\s+/g, ' '), 280),
      author: i.authors?.[0] ? { name: i.authors[0].name } : undefined,
      publishedAt: normDate(i.date_published), tags: i.tags ?? [],
      provenance: prov({ tier: Tier.Native, adapter: 'rss', strategy: 'jsonfeed item', finalUrl: i.url ?? feedUrl }),
    });
  });
  return makeDoc({
    url: feedUrl, source: 'rss', kind: 'listing', title: feed.title ?? feedUrl,
    text: tidy([`# ${feed.title ?? feedUrl}`, feed.description ?? '', '', ...items.map((i, n) => `${n + 1}. **[${i.title}](${i.url})**`)].join('\n')),
    children: items,
    extra: { feedType: 'jsonfeed', itemCount: items.length, siteLink: feed.home_page_url },
    provenance: prov({ tier: Tier.Native, adapter: 'rss', strategy: 'jsonfeed', finalUrl: feedUrl }),
  });
}

function looksHtml(s: string): boolean {
  return /<\/?(p|div|a|br|img|ul|ol|h[1-6]|blockquote)\b/i.test(s);
}

function htmlToMd(html: string, base: string): string {
  try {
    return extractFromHtml(`<div id="f">${html}</div>`, base, { selector: '#f', collectLinks: false }).text;
  } catch {
    return tidy(html.replace(/<[^>]+>/g, ' '));
  }
}

function nonEmpty(s: string): string | undefined {
  return s.trim() ? s.trim() : undefined;
}

/**
 * Find a site's feed from its HTML. Used by `watch` to turn an expensive
 * page poll into a cheap feed poll.
 */
export function discoverFeeds(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('link[rel="alternate"]').each((_, el) => {
    const type = $(el).attr('type') ?? '';
    const href = $(el).attr('href');
    if (href && /rss|atom|feed\+json/i.test(type)) {
      try { out.add(new URL(href, baseUrl).href); } catch { /* bad href */ }
    }
  });
  // Conventional paths, as a last resort.
  if (out.size === 0) {
    for (const p of ['/feed', '/rss.xml', '/atom.xml', '/index.xml', '/feed.xml']) {
      try { out.add(new URL(p, baseUrl).href); } catch { /* unreachable */ }
    }
  }
  return [...out];
}
