import type { Scour } from '../core/pipeline.js';
import { canonicalUrl, isRelevant, relevanceScore } from '../core/pipeline.js';
import { clip } from '../core/extract.js';
import type { Document, FetchOptions, SearchResult } from '../core/types.js';
import { human } from '../adapters/_helpers.js';
import { pooledMap } from './pool.js';

export interface ResearchOptions extends FetchOptions {
  /** Sources to search (comma list or array). Default: all. */
  sources?: string | string[];
  /** How many documents to read in full. Default 8. */
  limit?: number;
  /** Per-document clip, in tokens. Default 1500. */
  perDocTokens?: number;
  onProgress?: (stage: string, detail: string) => void;
}

export interface ResearchSource {
  n: number;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  author?: string;
  engagement?: string;
}

export interface ResearchPack {
  question: string;
  generatedAt: string;
  sources: ResearchSource[];
  markdown: string;
  documents: Document[];
  errors: { url: string; error: string }[];
  stats: { searched: string; candidates: number; read: number; elapsedMs: number; costUsd: number };
}

/**
 * Search → read the best results in full → one cited Markdown pack.
 *
 * Search APIs sell "answers". scour hands you the evidence instead: a pack any
 * model can answer from, with numbered sources it can cite as [3]. The
 * synthesis is done by whichever AI reads the pack, so this stays free.
 */
export async function research(scour: Scour, question: string, opts: ResearchOptions = {}): Promise<ResearchPack> {
  const started = Date.now();
  const limit = opts.limit ?? 8;
  const source = Array.isArray(opts.sources) ? opts.sources.join(',') : opts.sources;

  opts.onProgress?.('search', source ?? 'all sources');
  const found = await scour.search(question, { ...opts, source, limit: Math.max(4, Math.ceil(limit * 0.75)) });
  const candidates = found.results.filter((r) => isRelevant(r, question));
  const base = candidates.length >= Math.min(3, found.results.length) ? candidates : found.results;
  // Rank by how squarely each hit is about the question; keep the original
  // (round-robin) order as the tie-breaker so sources stay mixed.
  const pool = base
    .map((r, i) => ({ r, i, s: relevanceScore(r, question) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
    .slice(0, Math.ceil(limit * 1.6));

  opts.onProgress?.('read', `${pool.length} candidates`);
  const settled = await pooledMap(pool, scour.config.concurrency, async (r) => {
    const doc = await scour.get(r.url, { ...opts, comments: 40 });
    return { r, doc };
  });

  const read: { r: SearchResult; doc: Document }[] = [];
  const errors: { url: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const [i, s] of settled.entries()) {
    if (!s.ok) {
      errors.push({ url: pool[i]!.url, error: s.error.message.split('\n')[0]! });
      continue;
    }
    const key = safeCanonical(s.value.doc.url);
    if (seen.has(key) || s.value.doc.text.trim().length < 200) continue;
    seen.add(key);
    read.push(s.value);
    if (read.length >= limit) break;
  }

  const sources: ResearchSource[] = read.map(({ r, doc }, i) => ({
    n: i + 1,
    title: (doc.title ?? r.title ?? doc.url).replace(/\s+/g, ' ').trim(),
    url: doc.url,
    source: doc.source,
    publishedAt: (doc.publishedAt ?? r.publishedAt)?.slice(0, 10),
    author: doc.author?.handle ? `@${doc.author.handle}` : doc.author?.name,
    engagement: engagementLine(doc),
  }));

  const generatedAt = new Date().toISOString();
  const md = [
    `# Research pack: ${question}`,
    '',
    `_Generated ${generatedAt.slice(0, 16).replace('T', ' ')} UTC by scour · ${sources.length} sources read in full · searched: ${found.provenance.strategy}_`,
    '',
    '> Give this file to any AI and ask it to answer the question using only these sources, citing them like [3].',
    '',
    '## Sources',
    '',
    ...sources.map((s) => `${s.n}. [${s.title}](${s.url}) — ${[s.source, s.publishedAt, s.author, s.engagement].filter(Boolean).join(' · ')}`),
    '',
    ...read.flatMap(({ doc }, i) => [
      '---',
      '',
      `## [${i + 1}] ${sources[i]!.title}`,
      `${doc.url}`,
      '',
      clip(stripLeadingTitle(doc.text, sources[i]!.title), opts.perDocTokens ?? 1500),
      '',
    ]),
  ].join('\n');

  return {
    question,
    generatedAt,
    sources,
    markdown: md,
    documents: read.map((x) => x.doc),
    errors,
    stats: {
      searched: found.provenance.strategy,
      candidates: pool.length,
      read: read.length,
      elapsedMs: Date.now() - started,
      costUsd: scour.budget.spentUsd,
    },
  };
}

function engagementLine(d: Document): string | undefined {
  const e = d.engagement;
  if (!e) return undefined;
  const parts = [
    e.score !== undefined ? `${human(e.score)} ${d.source === 'twitter' ? 'likes' : 'pts'}` : undefined,
    e.comments !== undefined ? `${human(e.comments)} comments` : undefined,
    e.views !== undefined ? `${human(e.views)} views` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

function stripLeadingTitle(text: string, title: string): string {
  const first = text.split('\n', 1)[0] ?? '';
  return first.replace(/^#+\s*/, '').trim() === title ? text.slice(first.length).trimStart() : text;
}

function safeCanonical(u: string): string {
  try {
    return canonicalUrl(new URL(u));
  } catch {
    return u;
  }
}
