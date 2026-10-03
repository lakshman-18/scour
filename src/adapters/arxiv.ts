import * as cheerio from 'cheerio';
import { normDate, tidy } from '../core/extract.js';
import { convertDocument } from '../core/documents.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document, type SearchResult } from '../core/types.js';
import { makeDoc, prov, truncate } from './_helpers.js';

/**
 * arXiv: metadata and abstract from the official API, plus the full paper
 * text from its PDF (converted locally). Free, no key.
 */
const API = 'https://export.arxiv.org/api/query';

interface Entry { id: string; title: string; summary: string; authors: string[]; published?: string; updated?: string; categories: string[]; pdf?: string }

export const arxivAdapter: Adapter = {
  name: 'arxiv',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)arxiv\.org$/.test(url.hostname) && /^\/(abs|pdf|html)\//.test(url.pathname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const id = arxivId(url);
    if (!id) throw new TierError(`No arXiv id in ${url.href}`, Tier.Native, false);
    const res = await ctx.http.get(`${API}?id_list=${encodeURIComponent(id)}`, { timeoutMs: ctx.options.timeoutMs });
    const entry = parseEntries(res.body)[0];
    if (!entry || !entry.title) throw new TierError(`arXiv has no paper ${id}`, Tier.Native, false);

    // Full text from the PDF; the abstract alone is rarely enough to work from.
    let fullText = '';
    let pages: number | undefined;
    try {
      const pdf = await ctx.http.get(entry.pdf ?? `https://arxiv.org/pdf/${id}`, { timeoutMs: Math.max(ctx.options.timeoutMs, 60_000) });
      if (pdf.raw?.length) {
        const conv = await convertDocument(pdf.raw, 'pdf', { maxPages: 60 });
        fullText = conv.text;
        pages = conv.pages;
      }
    } catch (err) {
      ctx.log.debug(`arxiv pdf for ${id} failed: ${(err as Error).message}`);
    }

    const text = [
      `# ${entry.title}`, '',
      `**${entry.authors.join(', ')}** · arXiv:${id} · ${entry.published?.slice(0, 10) ?? ''} · ${entry.categories.join(', ')}`, '',
      '## Abstract', '', entry.summary, '',
      ...(fullText ? ['---', '', `## Full text${pages ? ` (${pages} pages)` : ''}`, '', fullText] : ['_Full text unavailable; abstract only._']),
    ].join('\n');

    return makeDoc({
      url: `https://arxiv.org/abs/${id}`, source: 'arxiv', nativeId: id, kind: 'article',
      title: entry.title, text: tidy(text), excerpt: truncate(entry.summary, 300),
      author: { name: entry.authors.slice(0, 3).join(', ') + (entry.authors.length > 3 ? ' et al.' : '') },
      publishedAt: normDate(entry.published), updatedAt: normDate(entry.updated), tags: entry.categories,
      links: [{ url: entry.pdf ?? `https://arxiv.org/pdf/${id}`, text: 'PDF' }],
      extra: { arxivId: id, authors: entry.authors, pages, fullText: !!fullText },
      provenance: prov({ tier: Tier.Native, adapter: 'arxiv', strategy: fullText ? 'api + pdf full text' : 'api abstract', finalUrl: url.href, httpStatus: 200 }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const q = query.trim().split(/\s+/).map((t) => `all:${encodeURIComponent(t)}`).join('+AND+');
    const res = await ctx.http.get(`${API}?search_query=${q}&max_results=${limit}&sortBy=relevance`, { timeoutMs: ctx.options.timeoutMs });
    return parseEntries(res.body).map((e) => ({
      title: e.title,
      url: `https://arxiv.org/abs/${e.id}`,
      snippet: truncate(e.summary.replace(/\s+/g, ' '), 300),
      source: 'arxiv',
      publishedAt: normDate(e.published),
      author: { name: e.authors.slice(0, 3).join(', ') + (e.authors.length > 3 ? ' et al.' : '') },
      extra: { categories: e.categories },
    }));
  },
};

export function arxivId(url: URL): string | null {
  return /^\/(?:abs|pdf|html)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?\/?$/.exec(url.pathname)?.[1] ?? null;
}

function parseEntries(xml: string): Entry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('entry').toArray().map((el) => {
    const e = $(el);
    const idUrl = e.children('id').text().trim();
    return {
      id: idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, ''),
      title: e.children('title').text().replace(/\s+/g, ' ').trim(),
      summary: e.children('summary').text().replace(/\s+/g, ' ').trim(),
      authors: e.children('author').toArray().map((a) => $(a).children('name').text().trim()),
      published: e.children('published').text().trim() || undefined,
      updated: e.children('updated').text().trim() || undefined,
      categories: e.children('category').toArray().map((c) => $(c).attr('term') ?? '').filter(Boolean),
      pdf: e.children('link[title="pdf"]').attr('href') ?? undefined,
    };
  });
}
