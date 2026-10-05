import type { Scour } from '../core/pipeline.js';
import { isAbout } from '../core/pipeline.js';
import { hashKey } from '../core/cache.js';
import { tweetId, tweetSnapshot, type TweetSnapshot } from '../adapters/twitter.js';
import type { SearchResult } from '../core/types.js';
import { extractFeatures } from './features.js';
import type { TrackedPost } from './analyze.js';
import { loadTopic, saveTopic, topicKey, type TrackedTopic } from './store.js';
import { pooledMap } from '../workflows/pool.js';

export interface CollectResult {
  topic: TrackedTopic;
  posts: TrackedPost[];
  added: number;
  refreshed: number;
  skippedOffTopic: number;
  errors: string[];
}

/**
 * One collection run for a topic: search, keep only on-topic posts, record
 * traits and current metrics, and re-check recent X posts already tracked so
 * their like counts over time give momentum.
 */
export async function collect(
  scour: Scour,
  query: string,
  opts: { sources?: string; limit?: number; refreshDays?: number; maxRefresh?: number } = {},
): Promise<CollectResult> {
  const sources = (opts.sources ?? 'twitter').toLowerCase().replace(/\bx\b/g, 'twitter');
  const now = new Date().toISOString();
  const existing = await loadTopic(query, sources);
  const topic: TrackedTopic = existing?.topic ?? { key: topicKey(query, sources), query, sources, createdAt: now, runs: 0 };
  const posts = new Map((existing?.posts ?? []).map((p) => [p.id, p]));
  const errors: string[] = [];

  // One search sees only part of what's indexed. Widen it within the free
  // search quota: an all-time and a past-week search on a topic's first run,
  // then one per run, alternating. (Re-checking tracked X posts below is free.)
  const variants: (undefined | 'week')[] = topic.runs === 0 ? [undefined, 'week'] : [topic.runs % 2 ? 'week' : undefined];
  let results: SearchResult[] = [];
  for (const freshness of variants) {
    try {
      results.push(...(await scour.search(query, {
        source: sources, limit: opts.limit ?? 25, noCache: true, adapterOptions: freshness ? { freshness } : undefined,
      })).results);
    } catch (err) {
      errors.push(`search${freshness ? ' (past week)' : ''}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const seenUrls = new Set<string>();
  results = results.filter((r) => (seenUrls.has(r.url) ? false : (seenUrls.add(r.url), true)));
  const onTopic = results.filter((r) => isAbout(r, query));
  const skippedOffTopic = results.length - onTopic.length;

  // X posts: one cheap snapshot each, which carries format, quote and article
  // signals the search result alone does not.
  const tweetIds = new Set<string>();
  const others: SearchResult[] = [];
  for (const r of onTopic) {
    const id = safeTweetId(r.url);
    if (id) tweetIds.add(id);
    else others.push(r);
  }
  const cutoff = Date.now() - (opts.refreshDays ?? 7) * 86_400_000;
  const toRefresh = [...posts.values()]
    .filter((p) => p.source === 'twitter' && !tweetIds.has(p.id) && p.createdAt && Date.parse(p.createdAt) > cutoff)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, opts.maxRefresh ?? 40)
    .map((p) => p.id);

  let added = 0;
  let refreshed = 0;
  const snaps = await pooledMap([...tweetIds, ...toRefresh], 6, (id) => tweetSnapshot(id, scour.config.userAgent));
  [...tweetIds, ...toRefresh].forEach((id, i) => {
    const s = snaps[i]!;
    if (!s.ok || !s.value) {
      if (!s.ok) errors.push(`x ${id}: ${s.error.message}`);
      return;
    }
    const isNew = !posts.has(s.value.id);
    upsert(posts, fromSnapshot(s.value, now), now);
    if (isNew) added++;
    else refreshed++;
  });

  for (const r of others) {
    const id = `${r.source}:${hashKey(r.url).slice(0, 16)}`;
    const isNew = !posts.has(id);
    upsert(posts, {
      id, source: r.source, url: r.url,
      text: [r.title, r.snippet].filter(Boolean).join('\n'),
      author: r.author ? { handle: r.author.handle, name: r.author.name } : undefined,
      createdAt: r.publishedAt,
      firstSeenAt: now, lastSeenAt: now,
      features: extractFeatures({ text: [r.title, r.snippet].filter(Boolean).join('\n'), createdAt: r.publishedAt }),
      metrics: { likes: r.engagement?.score, replies: r.engagement?.comments, shares: r.engagement?.shares, views: r.engagement?.views },
      history: [],
    }, now);
    if (isNew) added++;
    else refreshed++;
  }

  topic.lastRunAt = now;
  topic.runs += 1;
  const all = [...posts.values()];
  await saveTopic(topic, all);
  return { topic, posts: all, added, refreshed, skippedOffTopic, errors };
}

function fromSnapshot(s: TweetSnapshot, now: string): TrackedPost {
  return {
    id: s.id, source: 'twitter', url: s.url, text: s.text,
    author: s.author ? { handle: s.author.handle, name: s.author.name } : undefined,
    createdAt: s.createdAt, firstSeenAt: now, lastSeenAt: now,
    features: extractFeatures({ text: s.text, createdAt: s.createdAt, media: s.media, isArticle: s.isArticle, hasQuote: s.hasQuote, links: s.links, isReply: s.isReply }),
    metrics: { likes: s.likes, replies: s.replies },
    history: [],
  };
}

/** Merge a fresh observation, appending to history at most every 30 minutes. */
function upsert(posts: Map<string, TrackedPost>, fresh: TrackedPost, now: string): void {
  const prev = posts.get(fresh.id);
  const point = { t: now, likes: fresh.metrics.likes, replies: fresh.metrics.replies, views: fresh.metrics.views };
  if (!prev) {
    posts.set(fresh.id, { ...fresh, history: [point] });
    return;
  }
  const last = prev.history[prev.history.length - 1];
  const history = !last || Date.parse(now) - Date.parse(last.t) >= 30 * 60_000 ? [...prev.history, point].slice(-48) : prev.history;
  posts.set(fresh.id, {
    ...prev,
    text: fresh.text || prev.text,
    features: fresh.features,
    metrics: { ...prev.metrics, ...Object.fromEntries(Object.entries(fresh.metrics).filter(([, v]) => v !== undefined)) },
    lastSeenAt: now,
    history,
  });
}

function safeTweetId(url: string): string | null {
  try {
    const u = new URL(url);
    return /(^|\.)(x|twitter)\.com$/.test(u.hostname) ? tweetId(u) : null;
  } catch {
    return null;
  }
}
