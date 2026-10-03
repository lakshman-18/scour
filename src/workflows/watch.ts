import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configHome } from '../core/config.js';
import { hashKey, stableHash } from '../core/cache.js';
import { canonicalUrl, isAbout, normaliseUrl, type Scour } from '../core/pipeline.js';
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
  /** When the watch was first baselined. */
  createdAt?: string;
  options?: FetchOptions;
  /** Set for topic watches: re-run this search instead of fetching a URL. */
  search?: { query: string; sources?: string };
  /** Alert targets saved with this watch (see notify.ts). */
  notify?: string[];
  runs: number;
}

function watchDir(): string {
  return path.join(configHome(), 'watch');
}

function stateFile(key: string): string {
  const id = key.startsWith('search:') ? key : canonicalUrl(normaliseUrl(key));
  return path.join(watchDir(), `${hashKey(id).slice(0, 24)}.json`);
}

/** Stable identity for a topic watch: same query + sources → same state file. */
export function searchKey(query: string, sources?: string): string {
  const src = (sources ?? 'all').toLowerCase().split(/[,\s]+/).filter(Boolean).sort().join(',');
  return `search:${src}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
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
type WatchOpts = FetchOptions & { label?: string; reset?: boolean; dryRun?: boolean; notify?: string[] };

export async function watch(scour: Scour, url: string, opts: WatchOpts = {}): Promise<WatchResult> {
  // Always bypass the read cache: a watch that reads its own cache is a no-op.
  return watchCore(url, () => scour.get(url, { ...opts, noCache: true }), opts);
}

/**
 * Topic watch: re-run a search and report results that have never appeared
 * before. "Tell me when anyone posts about X on Reddit, HN or X."
 */
export async function watchSearch(
  scour: Scour,
  query: string,
  opts: WatchOpts & { sources?: string } = {},
): Promise<WatchResult> {
  const key = searchKey(query, opts.sources);
  return watchCore(key, () => searchDocument(scour, query, opts.sources, opts), {
    ...opts,
    label: opts.label ?? `“${query}”${opts.sources ? ` on ${opts.sources}` : ''}`,
  }, { query, sources: opts.sources });
}

async function searchDocument(scour: Scour, query: string, sources: string | undefined, opts: FetchOptions): Promise<Document> {
  const r = await scour.search(query, { ...opts, source: sources, limit: 15, noCache: true });
  // Only results that are actually about the topic; keyword noise would
  // otherwise trigger alerts every time the engines reshuffle.
  const children: Document[] = r.results.filter((x) => isAbout(x, query)).map((x) => ({
    // Identity is the canonical URL, so re-ranking never looks like "new".
    id: `${x.source}:${hashKey(safeCanonical(x.url)).slice(0, 16)}`,
    url: x.url,
    source: x.source,
    kind: 'post',
    title: x.title,
    text: x.snippet ?? '',
    excerpt: x.snippet ? x.snippet.replace(/\s+/g, ' ').slice(0, 240) : undefined,
    author: x.author,
    publishedAt: x.publishedAt,
    engagement: x.engagement,
    provenance: { ...r.provenance, adapter: x.source, finalUrl: x.url },
  }));
  return {
    id: `search:${hashKey(searchKey(query, sources)).slice(0, 16)}`,
    url: `scour://search?q=${encodeURIComponent(query)}${sources ? `&sources=${encodeURIComponent(sources)}` : ''}`,
    source: 'search',
    kind: 'listing',
    title: `Search: ${query}`,
    text: children.map((c) => `- ${c.title} — ${c.url}`).join('\n'),
    children,
    provenance: r.provenance,
  };
}

function safeCanonical(u: string): string {
  try {
    return canonicalUrl(new URL(u));
  } catch {
    return u;
  }
}

async function watchCore(
  key: string,
  fetchDoc: () => Promise<Document>,
  opts: WatchOpts,
  search?: WatchState['search'],
): Promise<WatchResult> {
  const checkedAt = new Date().toISOString();
  const file = stateFile(key);
  const prev = opts.reset ? null : await readState(file);

  const doc = await fetchDoc();

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
        lastText: doc.text, lastSeenAt: checkedAt, lastChangedAt: checkedAt, createdAt: checkedAt,
        options: strip(opts), search, notify: opts.notify?.length ? opts.notify : undefined, runs: 1,
      });
    }
    return result;
  }

  const seen = new Set(prev.seenIds);
  // An old post that a search engine surfaces today is not news. Anything
  // dated before the watch began (with a 2-day grace) is recorded as seen but
  // never alerted on.
  const since = Date.parse(prev.createdAt ?? prev.lastSeenAt) - 2 * 86_400_000;
  const newItems = children.filter(
    (c) => !seen.has(c.id) && !(search && c.publishedAt && Date.parse(c.publishedAt) < since),
  );
  // For topic watches only new results matter; reordering is not a change.
  const textChanged = !search && doc.text !== prev.lastText;

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
      createdAt: prev.createdAt ?? prev.lastSeenAt,
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
    (s) =>
      s.search
        ? watchSearch(scour, s.search.query, { ...opts, ...s.options, sources: s.search.sources, label: s.label, notify: s.notify })
        : watch(scour, s.url, { ...opts, ...s.options, label: s.label, notify: s.notify }),
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

export async function removeWatch(urlOrKey: string): Promise<boolean> {
  const file = stateFile(urlOrKey);
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
