import { normDate, tidy } from '../core/extract.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document, type SearchResult } from '../core/types.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';
import { extractFromHtml } from '../core/extract.js';

/**
 * Hacker News via the Algolia API — unlimited, free, no key, no rate pain.
 * The single most reliable data source on the internet.
 */
interface HnItem {
  id: number; created_at: string; author: string; title?: string; url?: string;
  text?: string; points?: number; parent_id?: number | null; children?: HnItem[]; type?: string;
}

export const hackerNewsAdapter: Adapter = {
  name: 'hn',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)ycombinator\.com$/.test(url.hostname) && /\/item|\/news|^\/$/.test(url.pathname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const id = url.searchParams.get('id');
    if (!id) return frontPage(ctx, url);

    const item = await ctx.http.json<HnItem>(`https://hn.algolia.com/api/v1/items/${id}`, {
      timeoutMs: ctx.options.timeoutMs,
    });
    const depth = typeof ctx.options.comments === 'number' ? ctx.options.comments : ctx.options.comments === false ? 0 : 200;
    const kids = depth === 0 ? [] : (item.children ?? []).filter((c) => c.text).map(toComment);

    const body = [
      `# ${item.title ?? `Comment by ${item.author}`}`,
      '',
      `by **${item.author}** · ${human(item.points)} points · ${countAll(item.children ?? [])} comments`,
      '',
      item.url ? `🔗 ${item.url}\n` : '',
      item.text ? `${htmlToMd(item.text)}\n` : '',
    ];
    if (kids.length) body.push('---', '', '## Comments', '', renderThread(kids));

    return makeDoc({
      url: `https://news.ycombinator.com/item?id=${item.id}`,
      source: 'hn',
      nativeId: String(item.id),
      kind: item.title ? 'post' : 'comment',
      title: item.title,
      text: tidy(body.join('\n')),
      author: { handle: item.author, url: `https://news.ycombinator.com/user?id=${item.author}` },
      publishedAt: normDate(item.created_at),
      engagement: { score: item.points, comments: countAll(item.children ?? []) },
      links: item.url ? [{ url: item.url, external: true }] : [],
      children: kids,
      provenance: prov({ tier: Tier.Native, adapter: 'hn', strategy: 'algolia items', finalUrl: url.href, httpStatus: 200 }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({ query, hitsPerPage: String(limit), tags: 'story' });
    const res = await ctx.http.json<{ hits: { objectID: string; title: string; url?: string; author: string; points: number; num_comments: number; created_at: string; story_text?: string }[] }>(
      `https://hn.algolia.com/api/v1/search?${params}`,
      { timeoutMs: ctx.options.timeoutMs },
    );
    return (res.hits ?? []).map((h) => ({
      title: h.title,
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: truncate(h.story_text?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 280) || undefined,
      source: 'hn',
      publishedAt: normDate(h.created_at),
      author: { handle: h.author },
      engagement: { score: h.points, comments: h.num_comments },
      extra: { discussion: `https://news.ycombinator.com/item?id=${h.objectID}` },
    }));
  },
};

async function frontPage(ctx: AdapterContext, url: URL): Promise<Document> {
  const res = await ctx.http.json<{ hits: { objectID: string; title: string; url?: string; author: string; points: number; num_comments: number; created_at: string }[] }>(
    'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30',
    { timeoutMs: ctx.options.timeoutMs },
  );
  const lines = (res.hits ?? []).map(
    (h, i) =>
      `${i + 1}. **[${h.title}](${h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`})**\n` +
      `   ${human(h.points)} pts by ${h.author} · [${h.num_comments} comments](https://news.ycombinator.com/item?id=${h.objectID})`,
  );
  return makeDoc({
    url: url.href, source: 'hn', kind: 'listing', title: 'Hacker News front page',
    text: ['# Hacker News front page', '', ...lines].join('\n'),
    provenance: prov({ tier: Tier.Native, adapter: 'hn', strategy: 'algolia front_page', finalUrl: url.href, httpStatus: 200 }),
  });
}

function toComment(c: HnItem): Document {
  const kids = (c.children ?? []).filter((k) => k.text).map(toComment);
  return makeDoc({
    url: `https://news.ycombinator.com/item?id=${c.id}`,
    source: 'hn', nativeId: String(c.id), kind: 'comment',
    text: htmlToMd(c.text ?? ''),
    author: { handle: c.author },
    publishedAt: normDate(c.created_at),
    children: kids.length ? kids : undefined,
    provenance: prov({ tier: Tier.Native, adapter: 'hn', strategy: 'embedded', finalUrl: `https://news.ycombinator.com/item?id=${c.id}` }),
  });
}

function countAll(items: HnItem[]): number {
  return items.reduce((n, i) => n + 1 + countAll(i.children ?? []), 0);
}

/** HN comment bodies are a small HTML subset. */
function htmlToMd(html: string): string {
  try {
    return extractFromHtml(`<div>${html}</div>`, 'https://news.ycombinator.com', { selector: 'div', collectLinks: false }).text;
  } catch {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}

void TierError;
