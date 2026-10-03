import { normDate, tidy, extractFromHtml } from '../core/extract.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document, type SearchResult } from '../core/types.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';

/** Wikipedia via the free REST + action APIs. No key, generous limits. */
export const wikipediaAdapter: Adapter = {
  name: 'wikipedia',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)wikipedia\.org$/.test(url.hostname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const lang = url.hostname.split('.')[0] || 'en';
    const title = decodeURIComponent(url.pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
    if (!title) throw new TierError('No article title in the Wikipedia URL.', Tier.Native, false);

    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const params = new URLSearchParams({
      action: 'query', format: 'json', prop: 'extracts|pageimages|info|categories',
      explaintext: '1', exsectionformat: 'wiki', inprop: 'url', piprop: 'original',
      cllimit: '20', titles: title, redirects: '1', origin: '*',
    });
    const json = await ctx.http.json<{ query?: { pages?: Record<string, any> } }>(`${api}?${params}`, {
      timeoutMs: ctx.options.timeoutMs,
    });
    const page = Object.values(json.query?.pages ?? {})[0];
    if (!page || page.missing !== undefined) throw new TierError(`Wikipedia has no article "${title}".`, Tier.Native, false);

    const text: string = page.extract ?? '';
    return makeDoc({
      url: page.fullurl ?? url.href,
      source: 'wikipedia',
      nativeId: `${lang}:${page.pageid}`,
      kind: 'article',
      title: page.title,
      // The action API returns wikitext-style "== Heading ==" — normalise to Markdown.
      text: tidy(`# ${page.title}\n\n${text.replace(/^(=+)\s*(.+?)\s*\1$/gm, (_m, eq: string, h: string) => `${'#'.repeat(eq.length)} ${h}`)}`),
      excerpt: truncate(text.split('\n')[0], 300),
      lang,
      updatedAt: normDate(page.touched),
      media: page.original?.source ? [{ type: 'image' as const, url: page.original.source }] : [],
      tags: (page.categories ?? []).map((c: { title: string }) => c.title.replace(/^Category:/, '')).slice(0, 15),
      extra: { pageId: page.pageid, lang },
      provenance: prov({ tier: Tier.Native, adapter: 'wikipedia', strategy: 'action api extracts', finalUrl: page.fullurl ?? url.href, httpStatus: 200 }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      action: 'query', format: 'json', list: 'search', srsearch: query,
      srlimit: String(limit), origin: '*',
    });
    const json = await ctx.http.json<{ query?: { search?: { title: string; snippet: string; timestamp: string; pageid: number }[] } }>(
      `https://en.wikipedia.org/w/api.php?${params}`, { timeoutMs: ctx.options.timeoutMs },
    );
    return (json.query?.search ?? []).map((s) => ({
      title: s.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
      snippet: s.snippet.replace(/<[^>]+>/g, '').trim(),
      source: 'wikipedia',
      publishedAt: normDate(s.timestamp),
    }));
  },
};

/** Stack Overflow / Stack Exchange — free API, 300 req/day anonymous. */
export const stackOverflowAdapter: Adapter = {
  name: 'stackoverflow',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)(stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com|[\w-]+\.stackexchange\.com)$/.test(url.hostname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const site = siteFor(url);
    const id = /\/questions\/(\d+)/.exec(url.pathname)?.[1] ?? /^\/a\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) throw new TierError(`No question id in ${url.href}`, Tier.Native, false);

    const base = 'https://api.stackexchange.com/2.3';
    const common = `site=${site}&filter=withbody`;
    const [q, answers] = await Promise.all([
      ctx.http.json<{ items?: SeQuestion[] }>(`${base}/questions/${id}?${common}`, { timeoutMs: ctx.options.timeoutMs }),
      ctx.options.comments === false
        ? Promise.resolve({ items: [] as SeAnswer[] })
        : ctx.http.json<{ items?: SeAnswer[] }>(`${base}/questions/${id}/answers?${common}&sort=votes&order=desc&pagesize=10`, { timeoutMs: ctx.options.timeoutMs }).catch(() => ({ items: [] as SeAnswer[] })),
    ]);

    const item = q.items?.[0];
    if (!item) throw new TierError(`Stack Exchange has no question ${id} on ${site}.`, Tier.Native, false);

    const kids = (answers.items ?? []).map((a) =>
      makeDoc({
        url: `${item.link}#${a.answer_id}`, source: 'stackoverflow', nativeId: String(a.answer_id), kind: 'comment',
        text: `${a.is_accepted ? '**✓ Accepted**\n\n' : ''}${html(a.body, item.link)}`,
        author: { name: a.owner?.display_name, url: a.owner?.link },
        publishedAt: normDate(a.creation_date),
        engagement: { score: a.score },
        extra: { accepted: a.is_accepted },
        provenance: prov({ tier: Tier.Native, adapter: 'stackoverflow', strategy: 'se answers', finalUrl: item.link }),
      }),
    );

    const body = [
      `# ${item.title}`, '',
      `${human(item.score)} votes · ${human(item.view_count)} views · ${item.answer_count} answers · ` +
        `asked by ${item.owner?.display_name ?? '?'} · tags: ${item.tags.join(', ')}`,
      '', html(item.body, item.link),
    ];
    if (kids.length) body.push('', '---', '', `## Answers`, '', renderThread(kids));

    return makeDoc({
      url: item.link, source: 'stackoverflow', nativeId: String(item.question_id), kind: 'post',
      title: item.title, text: tidy(body.join('\n')),
      author: { name: item.owner?.display_name, url: item.owner?.link },
      publishedAt: normDate(item.creation_date),
      engagement: { score: item.score, comments: item.answer_count, views: item.view_count },
      tags: item.tags, children: kids,
      extra: { site, answered: item.is_answered, acceptedAnswerId: item.accepted_answer_id },
      provenance: prov({ tier: Tier.Native, adapter: 'stackoverflow', strategy: 'se questions', finalUrl: item.link, httpStatus: 200 }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, site: 'stackoverflow', pagesize: String(limit), order: 'desc', sort: 'relevance' });
    const json = await ctx.http.json<{ items?: SeQuestion[] }>(`https://api.stackexchange.com/2.3/search/advanced?${params}`, {
      timeoutMs: ctx.options.timeoutMs,
    });
    return (json.items ?? []).map((i) => ({
      title: i.title,
      url: i.link,
      snippet: i.tags.join(', '),
      source: 'stackoverflow',
      publishedAt: normDate(i.creation_date),
      author: { name: i.owner?.display_name },
      engagement: { score: i.score, comments: i.answer_count, views: i.view_count },
      extra: { answered: i.is_answered },
    }));
  },
};

interface SeOwner { display_name?: string; link?: string }
interface SeQuestion {
  question_id: number; title: string; body: string; link: string; score: number;
  view_count: number; answer_count: number; tags: string[]; creation_date: number;
  is_answered: boolean; accepted_answer_id?: number; owner?: SeOwner;
}
interface SeAnswer { answer_id: number; body: string; score: number; is_accepted: boolean; creation_date: number; owner?: SeOwner }

function siteFor(url: URL): string {
  const h = url.hostname.replace(/^www\./, '');
  if (h === 'stackoverflow.com') return 'stackoverflow';
  if (h.endsWith('.stackexchange.com')) return h.replace('.stackexchange.com', '');
  return h.replace(/\.com$/, '');
}

function html(body: string, base: string): string {
  try {
    return extractFromHtml(`<div id="b">${body}</div>`, base, { selector: '#b', collectLinks: false }).text;
  } catch {
    return body.replace(/<[^>]+>/g, '');
  }
}
