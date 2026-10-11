import * as cheerio from 'cheerio';
import type { Scour } from '../core/pipeline.js';
import { canonicalUrl, normaliseUrl } from '../core/pipeline.js';
import type { Document, FetchOptions } from '../core/types.js';
import { pooledMap } from './pool.js';

export interface CrawlOptions extends FetchOptions {
  /** Link depth from the seed. 0 = just the seed. Default 2. */
  depth?: number;
  /** Hard cap on pages. Default 50 — crawls should be bounded by default. */
  limit?: number;
  /** Stay on the seed's host. Default true. */
  sameHost?: boolean;
  /** Only follow URLs whose href matches. */
  include?: RegExp;
  /** Never follow URLs whose href matches. */
  exclude?: RegExp;
  concurrency?: number;
  /** Seed the frontier from /sitemap.xml instead of following links. Default true. */
  useSitemap?: boolean;
  onPage?: (doc: Document, depth: number, queued: number) => void;
  /**
   * Save progress to this file after every batch; run again with the same
   * file to continue where an interrupted crawl stopped. Deleted when the
   * crawl finishes.
   */
  statePath?: string;
}

interface CrawlState {
  seed: string;
  seen: string[];
  frontier: { url: string; depth: number }[];
  visited: number;
  discovered: number;
}

export interface CrawlResult {
  documents: Document[];
  errors: { url: string; error: string }[];
  stats: { visited: number; discovered: number; elapsedMs: number; costUsd: number; seededFromSitemap: boolean };
}

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|mp3|wav|avi|mov|dmg|exe)(\?|$)/i;

/**
 * Breadth-first crawl with a sitemap shortcut.
 *
 * Checking the sitemap first usually turns a 50-request link crawl into one
 * request plus the pages you actually wanted — so it is on by default.
 */
export async function crawl(scour: Scour, seed: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const started = Date.now();
  const maxDepth = opts.depth ?? 2;
  const limit = opts.limit ?? 50;
  const sameHost = opts.sameHost !== false;
  const seedUrl = normaliseUrl(seed);
  const robots = opts.respectRobots === false ? null : await loadRobots(scour, seedUrl);

  const seen = new Set<string>([canonicalUrl(seedUrl)]);
  const documents: Document[] = [];
  const errors: { url: string; error: string }[] = [];
  let discovered = 1;
  let seededFromSitemap = false;

  let frontier: { url: string; depth: number }[] = [{ url: seedUrl.href, depth: 0 }];
  let visitedBefore = 0;

  const saved = opts.statePath ? await readState(opts.statePath) : null;
  if (saved && saved.seed === seedUrl.href) {
    for (const k of saved.seen) seen.add(k);
    frontier = saved.frontier;
    visitedBefore = saved.visited;
    discovered = saved.discovered;
    scour.log.info(`resuming crawl: ${saved.visited} pages done, ${saved.frontier.length} queued`);
  } else if (opts.useSitemap !== false && maxDepth > 0) {
    const fromMap = await sitemapUrls(scour, seedUrl).catch(() => []);
    const usable = fromMap.filter((u) => allowed(u, seedUrl, sameHost, opts, robots) && !seen.has(canonicalUrl(new URL(u))));
    if (usable.length > 0) {
      seededFromSitemap = true;
      for (const u of usable.slice(0, limit - 1)) {
        seen.add(canonicalUrl(new URL(u)));
        frontier.push({ url: u, depth: 1 });
        discovered++;
      }
      scour.log.debug(`sitemap seeded ${usable.length} URLs`);
    }
  }

  const done = () => visitedBefore + documents.length;
  while (frontier.length > 0 && done() < limit) {
    const wave = frontier.splice(0, limit - done());
    frontier = frontier.concat();

    const settled = await pooledMap(
      wave,
      opts.concurrency ?? scour.config.concurrency,
      async (node) => ({ node, doc: await scour.get(node.url, opts) }),
    );

    const nextWave: { url: string; depth: number }[] = [];
    for (const [i, s] of settled.entries()) {
      if (!s.ok) {
        errors.push({ url: wave[i]!.url, error: s.error.message });
        continue;
      }
      const { node, doc } = s.value;
      documents.push(doc);
      opts.onPage?.(doc, node.depth, frontier.length + nextWave.length);
      if (done() >= limit) break;
      if (node.depth >= maxDepth) continue;

      for (const link of doc.links ?? []) {
        if (!allowed(link.url, seedUrl, sameHost, opts, robots)) continue;
        let key: string;
        try {
          key = canonicalUrl(new URL(link.url));
        } catch {
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        discovered++;
        nextWave.push({ url: link.url, depth: node.depth + 1 });
      }
    }
    frontier.push(...nextWave);
    if (opts.statePath) {
      await writeState(opts.statePath, { seed: seedUrl.href, seen: [...seen], frontier, visited: done(), discovered });
    }
  }
  if (opts.statePath && (frontier.length === 0 || done() >= limit)) {
    await (await import('node:fs/promises')).rm(opts.statePath, { force: true });
  }

  return {
    documents,
    errors,
    stats: { visited: documents.length, discovered, elapsedMs: Date.now() - started, costUsd: scour.budget.spentUsd, seededFromSitemap },
  };
}

function allowed(
  href: string,
  seed: URL,
  sameHost: boolean,
  opts: CrawlOptions,
  robots: RobotsRules | null,
): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (SKIP_EXT.test(u.pathname)) return false;
  if (sameHost && u.hostname !== seed.hostname) return false;
  if (opts.include && !opts.include.test(u.href)) return false;
  if (opts.exclude && opts.exclude.test(u.href)) return false;
  if (robots && !robotsAllows(robots, u.pathname)) return false;
  return true;
}

interface RobotsRules { disallow: string[]; allow: string[] }

async function loadRobots(scour: Scour, seed: URL): Promise<RobotsRules | null> {
  try {
    const doc = await scour.get(`${seed.origin}/robots.txt`, { ttl: 86_400, noCache: false });
    return parseRobots(doc.text);
  } catch {
    return null; // No robots.txt means no restrictions.
  }
}

/** Minimal robots.txt reader: the `*` group only, which is what crawlers owe. */
export function parseRobots(txt: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  let inStar = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [kRaw, ...rest] = line.split(':');
    const k = (kRaw ?? '').toLowerCase().trim();
    const v = rest.join(':').trim();
    if (k === 'user-agent') inStar = v === '*';
    else if (inStar && k === 'disallow' && v) rules.disallow.push(v);
    else if (inStar && k === 'allow' && v) rules.allow.push(v);
  }
  return rules;
}

export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const match = (p: string): number => (path.startsWith(p.replace(/\*$/, '')) ? p.length : 0);
  const allow = Math.max(0, ...rules.allow.map(match));
  const deny = Math.max(0, ...rules.disallow.map(match));
  return allow >= deny; // Longest match wins; ties go to allow, per convention.
}

/** Read /sitemap.xml, following one level of sitemap-index nesting. */
export async function sitemapUrls(scour: Scour, seed: URL): Promise<string[]> {
  const candidates = [`${seed.origin}/sitemap.xml`, `${seed.origin}/sitemap_index.xml`];
  for (const cand of candidates) {
    try {
      const doc = await scour.get(cand, { ttl: 3600 });
      const urls = parseSitemap(doc.text);
      if (urls.length) {
        if (urls.some((u) => /sitemap.*\.xml/i.test(u))) {
          const nested = urls.filter((u) => /\.xml/i.test(u)).slice(0, 3);
          const all: string[] = [];
          for (const n of nested) {
            const sub = await scour.get(n, { ttl: 3600 }).catch(() => null);
            if (sub) all.push(...parseSitemap(sub.text).filter((u) => !/\.xml$/i.test(u)));
          }
          if (all.length) return all;
        }
        return urls.filter((u) => !/\.xml$/i.test(u));
      }
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

export function parseSitemap(xml: string): string[] {
  // The generic adapter may have wrapped the XML in a code fence.
  const body = xml.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');
  const $ = cheerio.load(body, { xmlMode: true });
  const out: string[] = [];
  $('loc').each((_, el) => {
    const v = $(el).text().trim();
    if (v) out.push(v);
  });
  return out;
}

async function readState(file: string): Promise<CrawlState | null> {
  try {
    return JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf-8')) as CrawlState;
  } catch {
    return null;
  }
}

async function writeState(file: string, state: CrawlState): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
  await fs.rename(`${file}.tmp`, file); // never leave a half-written state behind
}
