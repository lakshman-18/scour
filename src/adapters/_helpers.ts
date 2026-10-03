import { hashKey } from '../core/cache.js';
import { Tier, TIER_NAMES, type Document, type DocumentKind, type Provenance } from '../core/types.js';

export interface ProvInit {
  tier: Tier;
  adapter: string;
  strategy: string;
  finalUrl: string;
  httpStatus?: number;
  costUsd?: number;
  bytes?: number;
}

export function prov(init: ProvInit): Provenance {
  return {
    tier: init.tier,
    tierName: TIER_NAMES[init.tier],
    adapter: init.adapter,
    strategy: init.strategy,
    finalUrl: init.finalUrl,
    httpStatus: init.httpStatus,
    elapsedMs: 0,
    costUsd: init.costUsd ?? 0,
    bytes: init.bytes ?? 0,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export function docId(source: string, nativeId: string | undefined, url: string): string {
  return nativeId ? `${source}:${nativeId}` : `${source}:${hashKey(url).slice(0, 16)}`;
}

export function makeDoc(input: Omit<Document, 'id' | 'text'> & { id?: string; text?: string; nativeId?: string }): Document {
  const { nativeId, ...rest } = input as Record<string, unknown> & Omit<Document, 'id' | 'text'>;
  return {
    ...(rest as Omit<Document, 'id' | 'text'>),
    id: input.id ?? docId(input.source, nativeId as string | undefined, input.url),
    text: input.text ?? '',
  };
}

/** Compact number formatting: 1234 -> 1.2k. Used in rendered text bodies. */
export function human(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function kindFromUrl(url: URL): DocumentKind {
  if (/\.(json|csv|tsv|xml|ya?ml|txt|md|py|ts|js|rs|go|java|rb)$/i.test(url.pathname)) return 'file';
  return 'unknown';
}

/** Render a comment tree into indented Markdown so an LLM reads it as a thread. */
export function renderThread(nodes: Document[], depth = 0, max = 6): string {
  const out: string[] = [];
  for (const n of nodes) {
    const pad = '  '.repeat(Math.min(depth, max));
    const who = n.author?.handle ?? n.author?.name ?? 'unknown';
    const score = n.engagement?.score;
    const meta = score !== undefined ? ` (${human(score)} pts)` : '';
    const body = n.text.split('\n').map((l) => (l ? `${pad}  ${l}` : '')).join('\n');
    out.push(`${pad}- **${who}**${meta}\n${body}`);
    if (n.children?.length) out.push(renderThread(n.children, depth + 1, max));
  }
  return out.join('\n');
}

export function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
