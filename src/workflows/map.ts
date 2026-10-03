import type { Scour } from '../core/pipeline.js';
import { canonicalUrl, normaliseUrl } from '../core/pipeline.js';
import type { FetchOptions } from '../core/types.js';
import { sitemapUrls } from './crawl.js';

export interface MapOptions extends FetchOptions {
  /** Only return URLs whose address or title contains this (case-insensitive). */
  search?: string;
  /** Maximum URLs returned. Default 5000. */
  limit?: number;
  /** Include subdomains of the seed host. Default false. */
  includeSubdomains?: boolean;
  /** Skip the sitemap. */
  ignoreSitemap?: boolean;
}

export interface MappedUrl {
  url: string;
  title?: string;
  /** Where we learned about it. */
  from: 'sitemap' | 'llms.txt' | 'page';
}

export interface MapResult {
  url: string;
  links: MappedUrl[];
  stats: { sitemap: number; llmsTxt: number; page: number; elapsedMs: number };
}

/**
 * List a site's URLs without fetching them: sitemap.xml, /llms.txt and the
 * links on the page itself. One to three requests instead of a crawl, which is
 * why it's the right first step before deciding what to read.
 */
export async function map(scour: Scour, input: string, opts: MapOptions = {}): Promise<MapResult> {
  const started = Date.now();
  const seed = normaliseUrl(input);
  const limit = opts.limit ?? 5000;
  const host = seed.hostname.replace(/^www\./, '');
  const sameSite = (u: URL): boolean => {
    const h = u.hostname.replace(/^www\./, '');
    return h === host || (!!opts.includeSubdomains && h.endsWith(`.${host}`));
  };

  const [fromSitemap, fromLlms, fromPage] = await Promise.all([
    opts.ignoreSitemap ? Promise.resolve([] as string[]) : sitemapUrls(scour, seed).catch(() => [] as string[]),
    llmsTxtLinks(scour, seed, opts).catch(() => [] as { url: string; title?: string }[]),
    scour
      .get(seed.href, { ...opts, comments: false })
      .then((d) => [{ url: d.url, title: d.title }, ...(d.links ?? []).map((l) => ({ url: l.url, title: l.text }))])
      .catch(() => [] as { url: string; title?: string }[]),
  ]);

  const seen = new Map<string, MappedUrl>();
  const add = (url: string, from: MappedUrl['from'], title?: string): void => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u)) return;
    const key = canonicalUrl(u);
    const existing = seen.get(key);
    if (existing) {
      existing.title ??= title;
      return;
    }
    seen.set(key, { url: key, title: title?.trim() || undefined, from });
  };

  for (const l of fromLlms) add(l.url, 'llms.txt', l.title);
  for (const u of fromSitemap) add(u, 'sitemap');
  for (const l of fromPage) add(l.url, 'page', l.title);

  let links = [...seen.values()];
  if (opts.search) {
    const q = opts.search.toLowerCase();
    links = links.filter((l) => l.url.toLowerCase().includes(q) || (l.title ?? '').toLowerCase().includes(q));
  }

  return {
    url: seed.href,
    links: links.slice(0, limit),
    stats: {
      sitemap: fromSitemap.length,
      llmsTxt: fromLlms.length,
      page: fromPage.length,
      elapsedMs: Date.now() - started,
    },
  };
}

/** /llms.txt is a Markdown index sites publish specifically for agents. */
async function llmsTxtLinks(scour: Scour, seed: URL, opts: FetchOptions): Promise<{ url: string; title?: string }[]> {
  const doc = await scour.get(`${seed.origin}/llms.txt`, { ...opts, ttl: opts.ttl ?? 3600 });
  if (doc.kind === 'article' && /<html/i.test(doc.text)) return [];
  return parseLlmsTxt(doc.text, seed.origin);
}

export function parseLlmsTxt(text: string, origin: string): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    try {
      out.push({ url: new URL(m[2]!, origin).href, title: m[1] });
    } catch {
      // skip malformed
    }
  }
  return out;
}
