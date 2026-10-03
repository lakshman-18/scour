import { color } from '../core/logger.js';
import type { Document, SearchResult } from '../core/types.js';
import { human } from '../adapters/_helpers.js';

/** Human-readable Markdown for a terminal or a pipe into a file. */
export function renderDocument(doc: Document, opts: { stats?: boolean } = {}): string {
  const head: string[] = [];
  if (doc.author?.handle || doc.author?.name) {
    head.push(`by ${doc.author.handle ? `@${doc.author.handle}` : doc.author.name}`);
  }
  if (doc.publishedAt) head.push(doc.publishedAt.slice(0, 10));
  const e = doc.engagement;
  if (e?.score !== undefined) head.push(`${human(e.score)} pts`);
  if (e?.comments !== undefined) head.push(`${human(e.comments)} comments`);
  if (e?.views !== undefined) head.push(`${human(e.views)} views`);

  const parts = [
    color.dim(`# source: ${doc.source} · kind: ${doc.kind} · ${doc.url}`),
    head.length ? color.dim(`# ${head.join(' · ')}`) : '',
    '',
    doc.title && !doc.text.trimStart().startsWith('# ') ? `# ${doc.title}\n` : '',
    doc.text,
  ];
  if (opts.stats) parts.push('', color.dim(statsLine(doc)));
  return parts.filter((p) => p !== '').join('\n');
}

export function statsLine(doc: Document): string {
  const p = doc.provenance;
  return (
    `[${p.tierName}] ${p.adapter}/${p.strategy} · ${p.elapsedMs}ms · ` +
    `${p.cached ? 'CACHED' : `${(p.bytes / 1024).toFixed(1)}KB`} · $${p.costUsd.toFixed(4)}` +
    (p.attempts?.length ? ` · ${p.attempts.length} fallback(s)` : '')
  );
}

export function renderSearch(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r, i) => {
      const meta = [
        r.source,
        r.publishedAt?.slice(0, 10),
        r.author?.handle ? `@${r.author.handle}` : r.author?.name,
        r.engagement?.score !== undefined ? `${human(r.engagement.score)} pts` : undefined,
        r.engagement?.comments !== undefined ? `${human(r.engagement.comments)} comments` : undefined,
        r.engagement?.views !== undefined ? `${human(r.engagement.views)} views` : undefined,
      ].filter(Boolean);
      return [
        color.bold(`${i + 1}. ${r.title}`),
        `   ${color.cyan(r.url)}`,
        `   ${color.dim(meta.join(' · '))}`,
        r.snippet ? `   ${truncateLine(r.snippet, 240)}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function truncateLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/** Strip the heavy fields so `--json` output stays pipe-friendly by default. */
export function slimDocument(doc: Document, keepChildren: boolean): Record<string, unknown> {
  const { children, ...rest } = doc;
  return keepChildren ? { ...rest, children } : rest;
}
