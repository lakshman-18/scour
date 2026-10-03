import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configHome } from '../core/config.js';
import { hashKey, stableHash } from '../core/cache.js';
import { canonicalUrl, normaliseUrl, type Scour } from '../core/pipeline.js';
import type { Document, FetchOptions } from '../core/types.js';
import { pooledMap } from './pool.js';

export type ChangeKind = 'first-run' | 'unchanged' | 'new-items' | 'content-changed';

export interface WatchResult {
  url: string;
  label?: string;
  changed: boolean;
  kind: ChangeKind;
  /** Items present now that weren't there last time (feeds, listings, threads). */
  newItems: Document[];
  /** Unified-ish diff of the body text, for single documents. */
  diff?: string;
  document: Document;
  previousSeenAt?: string;
  checkedAt: string;
  /** Alert targets saved with this watch, merged with any passed this run. */
  notify?: string[];
}

interface WatchState {
  url: string;
  label?: string;
  hash: string;
  /** Ids of children we have already reported, so we never repeat one. */
  seenIds: string[];
  lastText: string;
  lastSeenAt: string;
  lastChangedAt: string;
  options?: FetchOptions;
  /** Alert targets saved with this watch (see notify.ts). */
  notify?: string[];
  runs: number;
}

function watchDir(): string {
  return path.join(configHome(), 'watch');
}

function stateFile(url: string): string {
  return path.join(watchDir(), `${hashKey(canonicalUrl(normaliseUrl(url))).slice(0, 24)}.json`);
}

/**
 * Check a URL for changes since the last run.
 *
 * Two modes, picked automatically:
 *  - **Feeds and listings** (anything with children): report genuinely new
 *    items by id. This is the one that matters for workflows — you get only
 *    the new posts, never the whole feed again.
 *  - **Single documents**: report a line diff of the body.
 *
 * State lives in ~/.scour/watch, so this is safe to run from cron.
 */
export async function watch(
  scour: Scour,
  url: string,
  opts: FetchOptions & { label?: string; reset?: boolean; dryRun?: boolean; notify?: string[] } = {},
): Promise<WatchResult> {
  const checkedAt = new Date().toISOString();
  const file = stateFile(url);
  const prev = opts.reset ? null : await readState(file);

  // Always bypass the read cache: a watch that reads its own cache is a no-op.
  const doc = await scour.get(url, { ...opts, noCache: true });

  const children = doc.children ?? [];
  const currentIds = children.map((c) => c.id);
  const hash = stableHash({ text: doc.text, ids: currentIds });

  if (!prev) {
    const result: WatchResult = {
      url: doc.url, label: opts.label, changed: false, kind: 'first-run',
      newItems: [], document: doc, checkedAt, notify: opts.notify,
    };
    if (!opts.dryRun) {
      await writeState(file, {
        url: doc.url, label: opts.label, hash, seenIds: currentIds,
        lastText: doc.text, lastSeenAt: checkedAt, lastChangedAt: checkedAt,
        options: strip(opts), notify: opts.notify?.length ? opts.notify : undefined, runs: 1,
      });
    }
    return result;
  }

  const seen = new Set(prev.seenIds);
  const newItems = children.filter((c) => !seen.has(c.id));
  const textChanged = doc.text !== prev.lastText;

  let kind: ChangeKind = 'unchanged';
  if (newItems.length > 0) kind = 'new-items';
  else if (textChanged) kind = 'content-changed';

  const result: WatchResult = {
    url: doc.url,
    label: opts.label ?? prev.label,
    changed: kind !== 'unchanged',
    kind,
    newItems,
    diff: kind === 'content-changed' ? lineDiff(prev.lastText, doc.text) : undefined,
    document: doc,
    previousSeenAt: prev.lastSeenAt,
    checkedAt,
    notify: [...new Set([...(prev.notify ?? []), ...(opts.notify ?? [])])],
  };

  if (!opts.dryRun) {
    await writeState(file, {
      ...prev,
      url: doc.url,
      label: opts.label ?? prev.label,
      hash,
      // Cap the id set so a busy feed's state file can't grow without bound.
      seenIds: [...currentIds, ...prev.seenIds.filter((i) => !currentIds.includes(i))].slice(0, 2000),
      lastText: doc.text,
      lastSeenAt: checkedAt,
      lastChangedAt: result.changed ? checkedAt : prev.lastChangedAt,
      notify: opts.notify?.length ? [...new Set([...(prev.notify ?? []), ...opts.notify])] : prev.notify,
      runs: prev.runs + 1,
    });
  }

  return result;
}

/** Run every registered watch. Built for `scour watch --all` in a cron job. */
export async function watchAll(
  scour: Scour,
  opts: FetchOptions & { concurrency?: number; onResult?: (r: WatchResult) => void } = {},
): Promise<WatchResult[]> {
  const states = await listWatches();
  const settled = await pooledMap(
    states,
    opts.concurrency ?? 3,
    (s) => watch(scour, s.url, { ...opts, ...s.options, label: s.label, notify: s.notify }),
    (_s, _i, r) => {
      if (r.ok) opts.onResult?.(r.value);
    },
  );
  return settled.filter((s): s is { ok: true; value: WatchResult } => s.ok).map((s) => s.value);
}

export async function listWatches(): Promise<WatchState[]> {
  try {
    const files = await fs.readdir(watchDir());
    const out: WatchState[] = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const s = await readState(path.join(watchDir(), f));
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.url.localeCompare(b.url));
  } catch {
    return [];
  }
}

export async function removeWatch(url: string): Promise<boolean> {
  const file = stateFile(url);
  try {
    await fs.rm(file);
    return true;
  } catch {
    return false;
  }
}

export async function clearWatches(): Promise<number> {
  const all = await listWatches();
  await fs.rm(watchDir(), { recursive: true, force: true });
  return all.length;
}

async function readState(file: string): Promise<WatchState | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as WatchState;
  } catch {
    return null;
  }
}

async function writeState(file: string, state: WatchState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // 0600: saved notify targets include webhook URLs, which are secrets.
  await fs.writeFile(file, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

/** Drop transport-only options so stored watches stay portable. */
function strip(o: FetchOptions & { notify?: string[]; label?: string; reset?: boolean; dryRun?: boolean }): FetchOptions {
  const { signal, headers, proxy, notify, label, reset, dryRun, noCache, ...rest } = o;
  void signal; void headers; void proxy; void notify; void label; void reset; void dryRun; void noCache;
  return rest;
}

/** Saved alert targets for a URL's watch, if any. */
export async function savedNotify(url: string): Promise<string[]> {
  return (await readState(stateFile(url)))?.notify ?? [];
}

/**
 * Compact line diff. Not a full Myers implementation — for change *detection*
 * the useful output is "what lines appeared and disappeared", which an LCS
 * over unique lines gets right at a fraction of the complexity.
 */
export function lineDiff(before: string, after: string, context = 0): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const aSet = new Map<string, number>();
  for (const l of a) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  const bSet = new Map<string, number>();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);

  const removed: string[] = [];
  for (const [line, n] of aSet) {
    const kept = bSet.get(line) ?? 0;
    for (let i = 0; i < n - kept; i++) if (line.trim()) removed.push(line);
  }
  const added: string[] = [];
  for (const [line, n] of bSet) {
    const kept = aSet.get(line) ?? 0;
    for (let i = 0; i < n - kept; i++) if (line.trim()) added.push(line);
  }

  void context;
  const out: string[] = [];
  if (removed.length) out.push(...removed.slice(0, 40).map((l) => `- ${l}`));
  if (removed.length > 40) out.push(`- …and ${removed.length - 40} more removed lines`);
  if (added.length) out.push(...added.slice(0, 40).map((l) => `+ ${l}`));
  if (added.length > 40) out.push(`+ …and ${added.length - 40} more added lines`);
  return out.join('\n') || '(whitespace-only change)';
}
