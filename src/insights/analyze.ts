import { DIMENSIONS, type Features } from './features.js';

/** One observed post with its latest metrics and a short metric history. */
export interface TrackedPost {
  id: string;
  source: string;
  url: string;
  text: string;
  author?: { handle?: string; name?: string };
  createdAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  features: Features;
  metrics: { likes?: number; replies?: number; shares?: number; views?: number };
  history: { t: string; likes?: number; replies?: number; views?: number }[];
}

export interface Bucket { value: string; n: number; median: number; lift: number; confidence: 'low' | 'ok' | 'good' }
export interface DimensionResult { key: string; label: string; buckets: Bucket[] }

export interface InsightsReport {
  topic: string;
  generatedAt: string;
  sample: { posts: number; sources: string[]; from?: string; to?: string; metric: string; caveats: string[] };
  overall: { median: number; total: number };
  dimensions: DimensionResult[];
  findings: string[];
  topPosts: (TrackedPost & { score: number })[];
  rising: (TrackedPost & { score: number; perHour: number })[];
  phrases: { phrase: string; topCount: number; lift: number }[];
  authors: { handle: string; posts: number; total: number; best: number }[];
  daily: { day: string; posts: number; traction: number }[];
}

/**
 * Traction score. With views (paid X API) we measure reach; without them we
 * use what X gives away free: likes, with replies weighted higher because a
 * reply costs the reader more effort than a like.
 */
export function score(p: Pick<TrackedPost, 'metrics'>): number {
  const m = p.metrics;
  return (m.likes ?? 0) + 2 * (m.replies ?? 0) + 2 * (m.shares ?? 0) + (m.views ?? 0) / 100;
}

/** Likes gained per hour across the recorded history (needs ≥2 points ≥30 min apart). */
export function velocity(p: TrackedPost): number {
  const h = p.history.filter((x) => x.likes !== undefined);
  if (h.length < 2) return 0;
  const a = h[0]!;
  const b = h[h.length - 1]!;
  const hours = (Date.parse(b.t) - Date.parse(a.t)) / 3_600_000;
  if (hours < 0.5) return 0;
  return Math.max(0, ((b.likes ?? 0) - (a.likes ?? 0)) / hours);
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const STOP = new Set('the a an and or but of to in on for with at by from is are was were be been it its this that these those i you we they he she my our your their me us them as if so not no yes just more most very can will would should could do does did done have has had what which who how why when where all any some than then there here out up about into over after before also only new get got one two via amp rt'.split(' '));

export function analyze(topic: string, posts: TrackedPost[], now = Date.now()): InsightsReport {
  const scored = posts.map((p) => ({ ...p, score: score(p) }));
  const overallMedian = median(scored.map((p) => p.score));
  const hasViews = posts.some((p) => (p.metrics.views ?? 0) > 0);
  const sources = [...new Set(posts.map((p) => p.source))];

  // ---- which traits beat the median
  const dimensions: DimensionResult[] = DIMENSIONS.map(({ key, label }) => {
    const groups = new Map<string, number[]>();
    for (const p of scored) {
      const v = p.features[key];
      if (!v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p.score]);
    }
    const buckets: Bucket[] = [...groups.entries()]
      .map(([value, xs]) => {
        const med = median(xs);
        return {
          value, n: xs.length, median: med,
          lift: overallMedian > 0 ? med / overallMedian : 0,
          confidence: (xs.length >= 10 ? 'good' : xs.length >= 4 ? 'ok' : 'low') as Bucket['confidence'],
        };
      })
      .sort((a, b) => b.median - a.median);
    return { key, label, buckets };
  }).filter((d) => d.buckets.length >= 2);

  // ---- plain-language findings: only strong effects with enough posts
  const findings: string[] = [];
  for (const d of dimensions) {
    const best = d.buckets.find((b) => b.n >= 4);
    const worst = [...d.buckets].reverse().find((b) => b.n >= 4);
    if (best && best.lift >= 1.4) {
      findings.push(`${d.label}: **${best.value}** posts get ${best.lift.toFixed(1)}× the typical traction (${best.n} posts).`);
    }
    if (worst && worst !== best && worst.lift > 0 && worst.lift <= 0.6) {
      findings.push(`${d.label}: **${worst.value}** posts underperform at ${worst.lift.toFixed(1)}× typical (${worst.n} posts).`);
    }
  }

  // ---- what top posts say that the rest don't
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const cut = Math.max(1, Math.floor(sorted.length / 4));
  const top = sorted.slice(0, cut);
  const rest = sorted.slice(cut);
  const grams = (t: string): string[] => {
    const w = t.toLowerCase().replace(/https?:\/\/\S+|@\w+/g, ' ').replace(/[^\p{L}\p{N}#'\s]/gu, ' ').split(/\s+/)
      .filter((x) => x.length > 2 && !STOP.has(x) && !/^\d+$/.test(x));
    const out = new Set<string>(w);
    for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
    return [...out];
  };
  const topicWords = new Set(grams(topic));
  const count = (set: { text: string }[]) => {
    const m = new Map<string, number>();
    for (const p of set) for (const g of grams(p.text)) m.set(g, (m.get(g) ?? 0) + 1);
    return m;
  };
  const topCounts = count(top);
  const restCounts = count(rest);
  const phrases = [...topCounts.entries()]
    .filter(([g, c]) => c >= 2 && !topicWords.has(g))
    .map(([g, c]) => ({ phrase: g, topCount: c, lift: (c / top.length) / (((restCounts.get(g) ?? 0) + 0.5) / Math.max(rest.length, 1)) }))
    .filter((x) => x.lift >= 1.5)
    .sort((a, b) => b.lift * b.topCount - a.lift * a.topCount)
    .slice(0, 12);

  // ---- who drives the conversation
  const byAuthor = new Map<string, { posts: number; total: number; best: number }>();
  for (const p of scored) {
    const h = p.author?.handle;
    if (!h) continue;
    const a = byAuthor.get(h) ?? { posts: 0, total: 0, best: 0 };
    a.posts++; a.total += p.score; a.best = Math.max(a.best, p.score);
    byAuthor.set(h, a);
  }
  const authors = [...byAuthor.entries()].map(([handle, a]) => ({ handle, ...a })).sort((a, b) => b.total - a.total).slice(0, 10);

  // ---- activity over time
  const days = new Map<string, { posts: number; traction: number }>();
  for (const p of scored) {
    if (!p.createdAt) continue;
    const d = p.createdAt.slice(0, 10);
    const x = days.get(d) ?? { posts: 0, traction: 0 };
    x.posts++; x.traction += p.score;
    days.set(d, x);
  }
  const daily = [...days.entries()].map(([day, x]) => ({ day, ...x })).sort((a, b) => a.day.localeCompare(b.day)).slice(-21);

  const rising = scored
    .map((p) => ({ ...p, perHour: velocity(p) }))
    .filter((p) => p.perHour > 0)
    .sort((a, b) => b.perHour - a.perHour)
    .slice(0, 5);

  const caveats: string[] = [];
  if (!hasViews) caveats.push('Traction = likes + 2×replies. Views need the official X API (scour auth x-api; ~$0.005/post).');
  if (posts.length < 20) caveats.push(`Small sample (${posts.length} posts): treat patterns as hints, not proof. Tracking over time grows it.`);
  if (sources.includes('twitter')) caveats.push('Free X data comes from search-engine indexes, which favour already-popular posts, and has no follower counts: big accounts dominate traction.');
  if (!rising.length) caveats.push('No momentum data yet: momentum appears after the topic has been checked at least twice, 30+ minutes apart.');
  const dates = posts.map((p) => p.createdAt).filter(Boolean).sort() as string[];

  return {
    topic,
    generatedAt: new Date(now).toISOString(),
    sample: { posts: posts.length, sources, from: dates[0], to: dates[dates.length - 1], metric: hasViews ? 'views + likes + replies' : 'likes + replies', caveats },
    overall: { median: overallMedian, total: scored.reduce((s, p) => s + p.score, 0) },
    dimensions,
    findings,
    topPosts: sorted.slice(0, 5),
    rising,
    phrases,
    authors,
    daily,
  };
}

export interface TopicStanding {
  topic: string;
  /** Posts inside the comparison window. */
  posts: number;
  /** All posts tracked for the topic. */
  tracked?: number;
  median: number;
  total: number;
  momentum: number;
  newLast24h: number;
  best?: { url: string; text: string; score: number };
}

/**
 * Which topic is winning? Momentum (likes gained per hour across tracked
 * posts) when history exists; otherwise total traction. Both are shown so the
 * ranking is never a black box.
 */
export function compareTopics(
  entries: { topic: string; posts: TrackedPost[] }[],
  now = Date.now(),
  windowDays = 7,
): TopicStanding[] {
  const since = now - windowDays * 86_400_000;
  return entries
    .map(({ topic, posts: all }) => {
      // "Winning" means now: rank on posts from the window (undated posts stay in).
      const posts = all.filter((p) => !p.createdAt || Date.parse(p.createdAt) >= since);
      const scores = posts.map(score);
      const best = posts.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0];
      return {
        topic,
        posts: posts.length,
        tracked: all.length,
        median: median(scores),
        total: scores.reduce((a, b) => a + b, 0),
        momentum: posts.reduce((s, p) => s + velocity(p), 0),
        newLast24h: posts.filter((p) => p.createdAt && now - Date.parse(p.createdAt) < 86_400_000).length,
        best: best ? { url: best.p.url, text: best.p.text.slice(0, 140), score: best.s } : undefined,
      };
    })
    .sort((a, b) => b.momentum - a.momentum || b.total - a.total);
}
