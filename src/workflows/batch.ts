import type { Scour } from '../core/pipeline.js';
import type { Document, FetchOptions } from '../core/types.js';
import { pooledMap } from './pool.js';

export interface BatchResult {
  documents: Document[];
  errors: { url: string; error: string }[];
  stats: {
    total: number; ok: number; failed: number;
    cached: number; costUsd: number; elapsedMs: number;
    byTier: Record<string, number>;
  };
}

/**
 * Fetch many URLs at bounded concurrency. Partial failure is normal and
 * expected — you get every document that worked plus a list of what didn't,
 * never an all-or-nothing rejection.
 */
export async function batch(
  scour: Scour,
  urls: string[],
  options: FetchOptions & { concurrency?: number; onProgress?: (done: number, total: number, url: string, ok: boolean) => void } = {},
): Promise<BatchResult> {
  const started = Date.now();
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  let done = 0;

  const settled = await pooledMap(
    unique,
    options.concurrency ?? scour.config.concurrency,
    (url) => scour.get(url, options),
    (url, _i, r) => {
      done++;
      options.onProgress?.(done, unique.length, url, r.ok);
    },
  );

  const documents: Document[] = [];
  const errors: { url: string; error: string }[] = [];
  const byTier: Record<string, number> = {};

  for (const [i, s] of settled.entries()) {
    if (s.ok) {
      documents.push(s.value);
      const t = s.value.provenance.tierName;
      byTier[t] = (byTier[t] ?? 0) + 1;
    } else {
      errors.push({ url: unique[i]!, error: s.error.message });
    }
  }

  return {
    documents,
    errors,
    stats: {
      total: unique.length,
      ok: documents.length,
      failed: errors.length,
      cached: documents.filter((d) => d.provenance.cached).length,
      costUsd: scour.budget.spentUsd,
      elapsedMs: Date.now() - started,
      byTier,
    },
  };
}
