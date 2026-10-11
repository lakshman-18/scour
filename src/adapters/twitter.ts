import { normDate } from '../core/extract.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type HttpResponse,
  type SearchResult,
} from '../core/types.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';
import type { Conversation } from './x-conversation.js';
import { sessionForHost } from '../render/sessions.js';
import { ALLOWANCES, costOf, recordUsage } from '../core/usage.js';
import { genericAdapter } from './generic.js';
import { matchQuery, parseQuery, type ParsedQuery } from '../core/query.js';

/**
 * Twitter / X.
 *
 * Reading a single tweet needs no account: the syndication endpoint that powers
 * every embedded tweet on the web serves the full object as JSON. An account's
 * latest posts come from the endpoint behind embedded profile timelines, also
 * public. Topic search without the paid API leans on search-engine indexes.
 */
export const twitterAdapter: Adapter = {
  name: 'twitter',
  priority: 50,
  completeSnippets: true,
  queryOperators: true,
  emptyHint(q) {
    if (q.from.length) return undefined; // they already read the account directly
    return 'Search engines index few posts from smaller accounts. Read an account directly with from:handle, ' +
      'add your own with `scour me x <handle>` (latest posts), or import your whole history with `scour import x-archive`.';
  },

  match(url: URL): boolean {
    return /^(www\.|mobile\.)?(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|nitter\.[\w.]+)$/.test(url.hostname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const articleId = xArticleId(url);
    if (articleId) return readArticle(articleId, ctx);

    const id = tweetId(url);
    if (!id) {
      const handle = url.pathname.split('/').filter(Boolean)[0];
      if (handle && !RESERVED.has(handle)) return profileDoc(handle, ctx, url);
      throw new TierError(`No tweet id in ${url.href}`, Tier.Native, false);
    }

    const errors: string[] = [];

    // Strategy 1: syndication CDN — zero config, the happy path.
    try {
      return await viaSyndication(id, ctx, url);
    } catch (err) {
      errors.push(`syndication: ${(err as Error).message}`);
    }

    // Strategy 2: oEmbed — less data, but a different host and often still up.
    try {
      return await viaOembed(id, url, ctx);
    } catch (err) {
      errors.push(`oembed: ${(err as Error).message}`);
    }

    throw new TierError(
      `Could not read tweet ${id}. Tried:\n  ${errors.join('\n  ')}\n` +
        '  Hint: `scour auth twitter` (Cookie-Editor export) unlocks search, timelines and protected tweets.',
      Tier.Native,
    );
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    // 1. Official X API (pay-per-use): live, complete, zero account risk.
    //    Only used when a token is configured AND the spending cap allows it.
    const token = ctx.config.providers.xBearerToken;
    if (token) {
      const n = Math.min(Math.max(limit, 10), 100); // the API's minimum page is 10
      const worstCase = await costOf('x-api-posts', n);
      if (ctx.budget.canAfford(worstCase)) {
        try {
          return await officialSearch(query, ctx, n, token, limit);
        } catch (err) {
          ctx.log.warn(`X API search failed (${(err as Error).message.split('\n')[0]}); using the free route`);
        }
      } else {
        ctx.log.warn(
          `X API is configured but this search could cost up to $${worstCase.toFixed(3)} (${n} posts × $${ALLOWANCES['x-api-posts']!.pricePerUnit}) ` +
            `and the cap is $${ctx.budget.capUsd.toFixed(2)}. Using the free route; pass --max-cost ${Math.max(0.05, worstCase).toFixed(2)} to use the API.`,
        );
      }
    }

    // 2. Your saved login (`scour login x`): X's own search, live and complete.
    if (await sessionForHost('x.com')) {
      try {
        const { sessionSearch } = await import('./x-conversation.js');
        const latest = (ctx.options.adapterOptions as { sort?: string } | undefined)?.sort === 'recent';
        const live = await sessionSearch(query, ctx, limit, latest);
        if (live.length) return live;
        ctx.note?.('X: your saved login found nothing for this search; trying the free routes.');
      } catch (err) {
        ctx.note?.(`X: saved login search failed (${(err as Error).message.split('\n')[0]}); used the free routes.`);
      }
    }

    // 3. Session cookies exported by hand (older route), if you chose to add them.
    const creds = ctx.config.credentials.twitter;
    if (creds) {
      try {
        const live = await sessionSearch(query, ctx, limit, creds);
        if (live.length) return live;
      } catch (err) {
        ctx.log.warn(`X session search failed (${(err as Error).message.split('\n')[0]}); using the search-engine route`);
      }
    }
    return freeSearch(parseQuery(query), ctx, limit);
  },

  async health(ctx: AdapterContext): Promise<HealthReport> {
    return twitterHealth(ctx);
  },
};

/**
 * Official X API v2 recent search (last 7 days). Billed per post returned, so
 * we check the worst case against the cap before the call and charge the
 * actual count after it.
 */
async function officialSearch(query: string, ctx: AdapterContext, pageSize: number, token: string, limit: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    query: /\bis:retweet\b/.test(query) ? query : `${query} -is:retweet`,
    max_results: String(pageSize),
    'tweet.fields': 'created_at,public_metrics,author_id,lang',
    expansions: 'author_id',
    'user.fields': 'username,name,verified,public_metrics',
  });
  const json = await ctx.http.json<{
    data?: { id: string; text: string; author_id: string; created_at?: string; public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; impression_count?: number } }[];
    includes?: { users?: { id: string; username: string; name: string; verified?: boolean; public_metrics?: { followers_count?: number } }[] };
    meta?: { result_count?: number };
    errors?: { message?: string }[];
  }>(`https://api.x.com/2/tweets/search/recent?${params}`, {
    timeoutMs: ctx.options.timeoutMs,
    retries: 0,
    headers: { Authorization: `Bearer ${token}` },
  });
  const posts = json.data ?? [];
  const cost = await costOf('x-api-posts', posts.length);
  ctx.budget.charge(cost, 'x api posts');
  await recordUsage('x-api-posts', posts.length);
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  return posts.slice(0, limit).map((t) => {
    const u = users.get(t.author_id);
    const m = t.public_metrics ?? {};
    return {
      title: truncate(decodeEntities(t.text).replace(/\s+/g, ' '), 100),
      url: `https://x.com/${u?.username ?? 'i'}/status/${t.id}`,
      snippet: decodeEntities(t.text),
      source: 'twitter',
      publishedAt: normDate(t.created_at),
      author: u ? { handle: u.username, name: u.name, verified: u.verified, followers: u.public_metrics?.followers_count } : undefined,
      engagement: { score: m.like_count, comments: m.reply_count, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0), views: m.impression_count },
      extra: { via: 'official X API (live)' },
    };
  });
}

/**
 * Search with no login and no spend, from three places:
 *
 * 1. Accounts read directly: from:handle, or your own accounts (`scour me x`)
 *    and any account the engines show is *named* after the query (@ToolmarkAI
 *    for "ToolMark"). Their recent posts come from the public timeline
 *    feed, so recent posts are found even when no search engine has them.
 * 2. Your imported X archive (`scour import x-archive`): everything you've posted.
 * 3. Search-engine indexes: popular, older tweets from anyone.
 *
 * Direct and archive posts are matched here; engine hits are returned whole so
 * the pipeline can say what it hid and why.
 */
async function freeSearch(q: ParsedQuery, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const own = (ctx.config.accounts?.x ?? []).map((h) => h.toLowerCase());
  const direct = q.from.length ? q.from : own;
  const matches = (r: SearchResult) => matchQuery(r, q, { complete: true }).ok;
  const problems: string[] = [];

  const [timelines, archived, indexed] = await Promise.all([
    Promise.all(direct.slice(0, 3).map((h) => timelinePosts(h, ctx).catch((err) => {
      problems.push(`@${h}: ${oneLine(err)}`);
      return [] as SearchResult[];
    }))),
    import('./x-archive.js').then((m) => m.searchArchives(q, limit * 2)).catch(() => [] as SearchResult[]),
    q.text.trim() || !q.from.length
      ? indexedSearch(q, ctx, limit).catch((err) => {
          const msg = oneLine(err);
          problems.push(/found nothing|returned no tweets/i.test(msg) ? 'search engines have no indexed posts for this query' : msg);
          return { tweets: [] as SearchResult[], profiles: [] as { handle: string; title: string }[] };
        })
      : Promise.resolve({ tweets: [] as SearchResult[], profiles: [] as { handle: string; title: string }[] }),
  ]);

  // Accounts named after the query: their own posts are about it.
  const named = q.from.length
    ? []
    : indexed.profiles.filter((p) => !direct.includes(p.handle.toLowerCase()) && namedAfter(p, q)).slice(0, 2);
  const brand = (await Promise.all(named.map((p) => timelinePosts(p.handle, ctx).catch(() => [] as SearchResult[])))).flat();

  const firstHand = [...timelines.flat(), ...archived, ...brand]
    .filter(matches)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const seen = new Set<string>();
  const out = [...firstHand, ...indexed.tweets].filter((r) => {
    const id = /status\/(\d+)/.exec(r.url)?.[1] ?? r.url;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!out.length && problems.length && !ctx.note) throw new TierError(problems.join('\n'), Tier.Native);
  for (const p of problems) ctx.note ? ctx.note(`X: ${p}`) : ctx.log.warn(`X: ${p}`);
  return out;
}

function oneLine(err: unknown): string {
  return (err as Error).message.replace(/\s*\n\s*/g, ' ').replace(/Tried: ?$/, '').trim();
}

/** "ToolmarkAI" / "ToolMark AI" for "ToolMark": the account carries the query's name. */
function namedAfter(p: { handle: string; title: string }, q: ParsedQuery): boolean {
  const names = q.exact.length ? q.exact.map((n) => n.toLowerCase()) : q.terms.filter((t) => t.length >= 4);
  if (!names.length) return false;
  const handle = p.handle.toLowerCase();
  const title = p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return names.every((n) => handle.includes(n) || title.includes(n));
}

/**
 * Search engines index public tweets; we ask them for x.com URLs, then read
 * each tweet in full through the syndication endpoint (exact text, likes,
 * replies, media, timestamp). Profile pages in the hits are returned too.
 * Not real-time: coverage is whatever the engines have indexed, typically
 * popular tweets from hours to days ago.
 */
async function indexedSearch(q: ParsedQuery, ctx: AdapterContext, limit: number): Promise<{ tweets: SearchResult[]; profiles: { handle: string; title: string }[] }> {
  const { webSearchAdapter } = await import('../search/websearch.js');
  const words = [...q.from, q.text].filter(Boolean).join(' ');
  const hits = await webSearchAdapter.search!(`site:x.com ${words}`, ctx, Math.min(limit * 3, 30));
  const ids: string[] = [];
  const profiles: { handle: string; title: string }[] = [];
  for (const h of hits) {
    try {
      const u = new URL(h.url);
      const id = tweetId(u);
      if (id) {
        if (!ids.includes(id)) ids.push(id);
        continue;
      }
      const handle = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(u.pathname)?.[1];
      if (handle && !RESERVED.has(handle.toLowerCase()) && !profiles.some((p) => p.handle === handle)) profiles.push({ handle, title: h.title ?? '' });
    } catch {
      // not a URL we can read
    }
  }
  if (ids.length === 0 && profiles.length === 0) {
    throw new TierError(
      'Search engines returned no tweets for this query. Without a login, X search relies on what engines have indexed; ' +
        'add from:handle to read an account directly.',
      Tier.Native,
    );
  }
  // Read more than the limit: the pipeline hides off-topic hits and fills
  // the page from the rest.
  const settled = await Promise.allSettled(ids.slice(0, Math.min(limit * 2, 30)).map((id) => syndicationJson(id, ctx)));
  const tweets: SearchResult[] = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value?.user) continue;
    const t = s.value;
    tweets.push({
      title: truncate(decodeEntities(t.article?.title ?? t.text ?? '').replace(/\s+/g, ' '), 100),
      url: `https://x.com/${t.user!.screen_name}/status/${t.id_str}`,
      snippet: [t.article?.title, cleanText(expandUrls(t.text ?? '', t.entities?.urls), (t.photos?.length ?? 0) + (t.mediaDetails?.length ?? 0) > 0)]
        .filter(Boolean)
        .join('\n'),
      source: 'twitter',
      publishedAt: normDate(t.created_at),
      author: { handle: t.user!.screen_name, name: t.user!.name, verified: t.user!.is_blue_verified ?? t.user!.verified },
      engagement: { score: t.favorite_count, comments: t.conversation_count },
      extra: { via: 'search-engine index + syndication' },
    });
  }
  return { tweets, profiles };
}

interface TimelineUser {
  id_str: string;
  screen_name: string;
  name: string;
  description?: string;
  location?: string;
  followers_count?: number;
  friends_count?: number;
  statuses_count?: number;
  created_at?: string;
  verified?: boolean;
  is_blue_verified?: boolean;
  profile_image_url_https?: string;
  protected?: boolean;
}

interface TimelineTweet {
  id_str: string;
  full_text?: string;
  text?: string;
  created_at: string;
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  quote_count?: number;
  in_reply_to_screen_name?: string;
  retweeted_status?: unknown;
  entities?: { urls?: { expanded_url: string; display_url: string }[]; hashtags?: { text: string }[] };
  extended_entities?: { media?: { type: string; media_url_https: string }[] };
  user: TimelineUser;
}

/**
 * An account's posts as X's embedded profile timeline shows them (20 to 100,
 * usually the most recent, with replies; reposts dropped). No login. X allows about
 * 30 reads per 15 minutes per IP, so results are cached for 15 minutes and a
 * rate-limited route rests for a few minutes before it is tried again.
 */
export async function profileTimeline(handle: string, ctx: AdapterContext): Promise<{ user?: TimelineUser; tweets: TimelineTweet[] }> {
  const h = handle.replace(/^@/, '');
  const key = `x:timeline:${h.toLowerCase()}`;
  const hit = await ctx.cache.get<{ user?: TimelineUser; tweets: TimelineTweet[] }>(key, 900);
  if (hit) return hit.value;
  // Two routes with separate allowances: by numeric id (rarely exhausted, so
  // preferred) and by name (often used up by other clients). Without the id
  // yet, we learn it from any one of the account's posts.
  let uid = (await ctx.cache.get<string>(`x:uid:${h.toLowerCase()}`, 90 * 86_400))?.value;
  let retryAt = Infinity;
  const read = async (route: 'id' | 'name', url: string): Promise<HttpResponse | undefined> => {
    const cooling = await ctx.cache.get<number>(`route:x-timeline-${route}:rate-limited`, 3600);
    if (cooling && cooling.value > Date.now()) {
      retryAt = Math.min(retryAt, cooling.value);
      return undefined;
    }
    const got = await ctx.http.get(url, { timeoutMs: ctx.options.timeoutMs, retries: 0, allowStatus: [429], headers: { Accept: 'text/html' } });
    if (got.status !== 429) return got;
    // A 429 often clears well before the advertised reset; look again after a few minutes at most.
    const reset = Number(got.headers['x-rate-limit-reset']) * 1000;
    const until = Math.min(Number.isFinite(reset) && reset > Date.now() ? reset : Infinity, Date.now() + 3 * 60_000);
    await ctx.cache.set(`route:x-timeline-${route}:rate-limited`, until, Math.ceil((until - Date.now()) / 1000));
    retryAt = Math.min(retryAt, until);
    return undefined;
  };
  const byId = (id: string) => `https://syndication.twitter.com/srv/timeline-profile/user-id/${id}`;
  let res = uid ? await read('id', byId(uid)) : undefined;
  if (!res) res = await read('name', `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(h)}`);
  if (!res && !uid) {
    uid = await discoverUserId(h, ctx).catch(() => undefined);
    if (uid) res = await read('id', byId(uid));
  }
  if (!res) {
    throw new TierError(
      `X's public timeline feed is rate-limited for ${Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))} more min` +
        (uid ? '.' : `, and no indexed post by @${h} was found to read the account id from. A link to any of their posts fixes that: scour get <post link>.`),
      Tier.Native,
    );
  }

  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(res.body);
  if (!m) throw new TierError('X changed its timeline page; could not find the timeline data.', Tier.Native);
  const data = JSON.parse(m[1]!) as { props?: { pageProps?: { timeline?: { entries?: { type?: string; content?: { tweet?: TimelineTweet } }[] } } } };
  const entries = data.props?.pageProps?.timeline?.entries ?? [];
  const all = entries.map((e) => e.content?.tweet).filter((t): t is TimelineTweet => !!t?.id_str && !!t.user);
  if (!all.length) {
    throw new TierError(`@${h} has no public posts X will show logged out (the account may be protected, suspended or not exist).`, Tier.Native, false);
  }
  const user = all.find((t) => t.user.screen_name.toLowerCase() === h.toLowerCase())?.user;
  const tweets = all.filter((t) => !t.retweeted_status && !/^RT @\w+:/.test(t.full_text ?? t.text ?? ''));
  if (user) await rememberUserId(user.screen_name, user.id_str, ctx);
  const value = { user, tweets };
  await ctx.cache.set(key, value, 900);
  return value;
}

/** The numeric id behind a handle, read from any one of the account's indexed posts. */
async function discoverUserId(handle: string, ctx: AdapterContext): Promise<string | undefined> {
  const { webSearchAdapter } = await import('../search/websearch.js');
  const hits = await webSearchAdapter.search!(`site:x.com ${handle}`, ctx, 10);
  for (const hit of hits) {
    let u: URL;
    try {
      u = new URL(hit.url);
    } catch {
      continue;
    }
    const id = tweetId(u);
    if (!id || u.pathname.split('/')[1]?.toLowerCase() !== handle.toLowerCase()) continue;
    const t = await syndicationJson(id, ctx).catch(() => null);
    if (t?.user?.id_str && t.user.screen_name.toLowerCase() === handle.toLowerCase()) return t.user.id_str;
  }
  return undefined;
}

async function timelinePosts(handle: string, ctx: AdapterContext): Promise<SearchResult[]> {
  // With a saved login, the account's real newest posts; the public embed
  // feed can lag by months for some accounts.
  if (await sessionForHost('x.com')) {
    try {
      const { sessionProfile, postToResult } = await import('./x-conversation.js');
      const posts = await sessionProfile(handle, ctx);
      if (posts.length) return posts.map((p) => postToResult(p, 'account timeline (your saved login)'));
    } catch (err) {
      ctx.log.debug(`saved-login profile read for @${handle} failed: ${(err as Error).message}`);
    }
  }
  const { tweets } = await profileTimeline(handle, ctx);
  return tweets.map((t) => timelineResult(t));
}

function timelineResult(t: TimelineTweet): SearchResult {
  const hasMedia = (t.extended_entities?.media?.length ?? 0) > 0;
  const text = cleanText(expandUrls(t.full_text ?? t.text ?? '', t.entities?.urls), hasMedia);
  return {
    title: truncate(text.replace(/\s+/g, ' '), 100),
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    snippet: text,
    source: 'twitter',
    publishedAt: normDate(t.created_at),
    author: { handle: t.user.screen_name, name: t.user.name, verified: t.user.is_blue_verified ?? t.user.verified, followers: t.user.followers_count },
    engagement: { score: t.favorite_count, comments: t.reply_count, shares: (t.retweet_count ?? 0) + (t.quote_count ?? 0) },
    extra: { via: 'account timeline', ...(t.in_reply_to_screen_name ? { replyTo: t.in_reply_to_screen_name } : {}) },
  };
}

/** Handle → numeric id, so a rate-limited by-name read can fall back to the by-id route. */
async function rememberUserId(handle: string, id: string, ctx: AdapterContext): Promise<void> {
  await ctx.cache.set(`x:uid:${handle.toLowerCase()}`, id, 90 * 86_400).catch(() => {});
}

async function sessionSearch(
  query: string,
  ctx: AdapterContext,
  limit: number,
  creds: { authToken: string; ct0: string },
): Promise<SearchResult[]> {
  const vars = {
    rawQuery: query,
    count: Math.min(limit, 20),
    querySource: 'typed_query',
    product: 'Top',
  };
  const features = {
    responsive_web_graphql_timeline_navigation_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    view_counts_everywhere_api_enabled: true,
  };
  const u =
    'https://api.x.com/graphql/nK1dw4oV3k4w5TdtcAdSww/SearchTimeline' +
    `?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(features))}`;

  const res = await ctx.http.get(u, {
    timeoutMs: ctx.options.timeoutMs,
    headers: {
      Authorization: `Bearer ${PUBLIC_BEARER}`,
      Cookie: `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
      'x-csrf-token': creds.ct0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'Content-Type': 'application/json',
    },
  });

  const json = JSON.parse(res.body) as Record<string, any>;
  const instructions = json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  const out: SearchResult[] = [];
  for (const inst of instructions) {
    for (const entry of inst.entries ?? []) {
      const t = entry?.content?.itemContent?.tweet_results?.result;
      const legacy = t?.legacy ?? t?.tweet?.legacy;
      const user = t?.core?.user_results?.result?.legacy ?? t?.tweet?.core?.user_results?.result?.legacy;
      if (!legacy || !user) continue;
      out.push({
        title: truncate(legacy.full_text?.replace(/\s+/g, ' '), 100),
        url: `https://x.com/${user.screen_name}/status/${legacy.id_str}`,
        snippet: legacy.full_text,
        source: 'twitter',
        publishedAt: normDate(legacy.created_at),
        author: { handle: user.screen_name, name: user.name, followers: user.followers_count, verified: user.verified },
        engagement: {
          score: legacy.favorite_count,
          comments: legacy.reply_count,
          shares: legacy.retweet_count,
          views: Number(t?.views?.count) || undefined,
        },
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function twitterHealth(ctx: AdapterContext): Promise<HealthReport> {
    const creds = ctx.config.credentials.twitter;
    const session = await sessionForHost('x.com');
    try {
      await syndicationJson('1', ctx).catch(() => null); // reachability probe only
    } catch {
      // ignore
    }
    return {
      adapter: 'twitter',
      status: creds || session ? 'ready' : 'degraded',
      detail: session
        ? 'Saved X login (scour login x): replies, live search and current profiles are read as you. Free routes are the fallback.'
        : creds
        ? 'Session cookies present (unofficial; risks the account). Indexed search is the fallback.'
        : ctx.config.providers.xBearerToken
          ? 'Official X API configured: live search when --max-cost allows ($0.005/post). Indexed search otherwise.'
          : 'Tweets, X Articles and accounts\' latest posts read with no account. Topic search uses search-engine indexes (popular tweets, not real-time); add from:handle to read an account directly.',
      fix: ctx.config.providers.xBearerToken || creds || session ? undefined : 'Replies and live search need a login: `scour login x` (you sign in yourself, in a browser window; use an account you can afford to risk). Or the official X API, pay-per-use: `scour auth x-api`.',
      capabilities: [
        'read tweet', 'read profile', 'thread (Thread Reader App)', 'indexed search', 'from:handle',
        ...(session ? ['replies', 'live search', 'current profiles'] : []),
        ...(ctx.config.providers.xBearerToken ? ['live search (paid)'] : creds ? ['live search (cookies)'] : []),
      ],
    };
}

const PUBLIC_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const RESERVED = new Set(['home', 'search', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'intent']);

/** The token the official embed widget derives from the tweet id. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, '');
}

interface SyndicationTweet {
  __typename?: string;
  id_str: string;
  text: string;
  created_at: string;
  favorite_count?: number;
  conversation_count?: number;
  user?: { id_str?: string; screen_name: string; name: string; profile_image_url_https?: string; verified?: boolean; is_blue_verified?: boolean };
  entities?: { urls?: { expanded_url: string; display_url: string }[]; hashtags?: { text: string }[] };
  mediaDetails?: { type: string; media_url_https: string; ext_alt_text?: string; video_info?: { duration_millis?: number } }[];
  photos?: { url: string; width: number; height: number }[];
  video?: { poster?: string; durationMs?: number; variants?: { src: string; type: string }[] };
  quoted_tweet?: SyndicationTweet;
  parent?: SyndicationTweet;
  in_reply_to_screen_name?: string;
  /** Present when the tweet is a long-form X Article. */
  article?: { id?: string; title?: string; preview_text?: string; cover_media?: { media_info?: { original_img_url?: string } } };
}

/** Minimal, cheap view of a tweet for analytics: one ~1.5 KB request, no page reads. */
export interface TweetSnapshot {
  id: string;
  url: string;
  text: string;
  createdAt?: string;
  likes?: number;
  replies?: number;
  author?: { handle: string; name?: string; verified?: boolean };
  media: { type: string }[];
  isArticle: boolean;
  articleTitle?: string;
  hasQuote: boolean;
  links: number;
  isReply: boolean;
}

export async function tweetSnapshot(id: string, userAgent?: string): Promise<TweetSnapshot | null> {
  const res = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`,
    { headers: { Referer: 'https://platform.twitter.com/', 'User-Agent': userAgent ?? 'Mozilla/5.0 scour' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;
  const t = (await res.json().catch(() => null)) as SyndicationTweet | null;
  if (!t?.user) return null;
  const media = buildMedia(t).map((m) => ({ type: m.type }));
  return {
    id: t.id_str ?? id,
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str ?? id}`,
    text: t.article?.title ? `${t.article.title}\n\n${t.article.preview_text ?? ''}` : decodeEntities(t.text ?? ''),
    createdAt: normDate(t.created_at),
    likes: t.favorite_count,
    replies: t.conversation_count,
    author: { handle: t.user.screen_name, name: t.user.name, verified: t.user.is_blue_verified ?? t.user.verified },
    media,
    isArticle: !!t.article,
    articleTitle: t.article?.title,
    hasQuote: !!t.quoted_tweet,
    links: (t.entities?.urls ?? []).length,
    isReply: !!t.in_reply_to_screen_name,
  };
}

/** `x.com/i/article/<id>` and `x.com/<user>/article/<id>`. The id is also the tweet id. */
export function xArticleId(url: URL): string | null {
  return /\/article\/(\d+)/.exec(url.pathname)?.[1] ?? null;
}

/**
 * Read a long-form X Article in full. X serves article pages fully rendered to
 * logged-out visitors, so this is a plain page read (headless only if X ever
 * stops doing that), enriched with the tweet's author, date and engagement
 * from the syndication endpoint. No account involved.
 */
async function readArticle(id: string, ctx: AdapterContext, tweet?: SyndicationTweet): Promise<Document> {
  const t = tweet ?? (await syndicationJson(id, ctx).catch(() => undefined));
  const handle = t?.user?.screen_name;
  const articleUrl = `https://x.com/${handle ?? 'i'}/article/${id}`;
  const page = await genericAdapter.fetch(new URL(articleUrl), ctx);
  if (page.text.length < 400) throw new Error(`article page returned only ${page.text.length} chars`);

  const title = t?.article?.title ?? page.title?.replace(/\s*\/\s*X$/, '');
  const cover = t?.article?.cover_media?.media_info?.original_img_url;
  return makeDoc({
    ...page,
    id: undefined,
    nativeId: id,
    url: articleUrl,
    source: 'twitter',
    kind: 'article',
    title,
    excerpt: t?.article?.preview_text ? truncate(t.article.preview_text.replace(/\s+/g, ' '), 280) : page.excerpt,
    author: handle
      ? { handle, name: t?.user?.name, url: `https://x.com/${handle}`, avatar: t?.user?.profile_image_url_https, verified: t?.user?.is_blue_verified ?? t?.user?.verified }
      : page.author,
    publishedAt: normDate(t?.created_at) ?? page.publishedAt,
    engagement: t ? { score: t.favorite_count, comments: t.conversation_count } : page.engagement,
    media: [...(cover ? [{ type: 'image' as const, url: cover }] : []), ...(page.media ?? [])],
    extra: { ...(page.extra ?? {}), xArticle: true, tweetUrl: handle ? `https://x.com/${handle}/status/${id}` : undefined },
    provenance: { ...page.provenance, adapter: 'twitter', strategy: `x article page (${page.provenance.strategy})` },
  });
}

async function syndicationJson(id: string, ctx: AdapterContext): Promise<SyndicationTweet> {
  const token = syndicationToken(id);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en&features=tfw_timeline_list%3A%3Btfw_follower_count_sunset%3Atrue`;
  const t = await ctx.http.json<SyndicationTweet>(url, {
    timeoutMs: ctx.options.timeoutMs,
    retries: 1,
    headers: { Accept: 'application/json', Referer: 'https://platform.twitter.com/' },
  });
  // Every tweet read teaches us its author's id, which unlocks the by-id timeline route.
  if (t?.user?.id_str) await rememberUserId(t.user.screen_name, t.user.id_str, ctx);
  return t;
}

async function viaSyndication(id: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const t = await syndicationJson(id, ctx);
  if (!t?.text && !t?.user) throw new Error('empty syndication payload (tweet deleted, protected or age-restricted)');

  // Long-form X Article posted as a tweet: the tweet itself is just a t.co
  // link, so read the article it carries (same id) instead.
  if (t.article) {
    try {
      return await readArticle(t.id_str ?? id, ctx, t);
    } catch (err) {
      ctx.log.warn(`could not read the attached X article (${(err as Error).message.split('\n')[0]}); returning the tweet`);
    }
  }

  const handle = t.user?.screen_name ?? 'unknown';
  const canonical = `https://x.com/${handle}/status/${t.id_str ?? id}`;
  const media = buildMedia(t);
  let body = cleanText(expandUrls(t.text ?? '', t.entities?.urls), media.length > 0);

  if (media.length) {
    body += `\n\n${media.map((m) => `![${m.alt ?? m.type}](${m.url})`).join('\n')}`;
  }
  if (t.quoted_tweet) {
    const q = t.quoted_tweet;
    body += `\n\n> **Quoting @${q.user?.screen_name}:**\n> ${decodeEntities(expandUrls(q.text ?? '', q.entities?.urls)).replace(/\n/g, '\n> ')}`;
  }

  const header = `**@${handle}**${t.user?.name ? ` (${t.user.name})` : ''}${t.user?.is_blue_verified || t.user?.verified ? ' ✓' : ''}`;
  const stats = `❤️ ${human(t.favorite_count)} · 💬 ${human(t.conversation_count)}`;

  // Replies and the author's thread, when asked for and there are any.
  const wanted = ctx.options.comments;
  let conversation: Conversation | undefined;
  if (wanted !== false && wanted !== 0 && (t.conversation_count ?? 0) > 0) {
    const { readConversation } = await import('./x-conversation.js');
    conversation = await readConversation(
      { id: t.id_str ?? id, handle, replies: t.conversation_count },
      ctx,
      typeof wanted === 'number' ? wanted : 100,
    ).catch((err) => {
      ctx.log.debug(`conversation for ${id}: ${(err as Error).message}`);
      return undefined;
    });
  }
  const threadMd = conversation?.thread.length
    ? `\n\n## Thread (${conversation.thread.length + 1} posts by @${handle})\n\n` +
      conversation.thread.map((p) => p.text).join('\n\n---\n\n')
    : '';
  const repliesMd = conversation?.replies.length
    ? `\n\n## Replies (${conversation.replyCount}, via ${conversation.via})\n\n${renderThread(conversation.replies)}`
    : '';
  const noteMd = conversation?.note ? `\n\n_${conversation.note}_` : '';

  return makeDoc({
    url: canonical,
    source: 'twitter',
    nativeId: t.id_str ?? id,
    kind: 'post',
    title: truncate(decodeEntities(t.text ?? '').replace(/\s+/g, ' '), 90),
    text: `${header}\n\n${body}\n\n_${stats}_${threadMd}${repliesMd}${noteMd}`,
    children: conversation?.replies.length ? conversation.replies : undefined,
    excerpt: truncate(decodeEntities(t.text ?? '').replace(/\s+/g, ' '), 280),
    author: {
      handle,
      name: t.user?.name,
      url: `https://x.com/${handle}`,
      avatar: t.user?.profile_image_url_https,
      verified: t.user?.is_blue_verified ?? t.user?.verified,
    },
    publishedAt: normDate(t.created_at),
    engagement: { score: t.favorite_count, comments: t.conversation_count },
    media,
    links: [
      ...(t.entities?.urls ?? []).map((u) => ({ url: u.expanded_url, text: u.display_url, external: true })),
      ...(conversation?.thread ?? []).flatMap((p) => p.links.map((l) => ({ url: l, text: l, external: true }))),
    ],
    tags: (t.entities?.hashtags ?? []).map((h) => `#${h.text}`),
    extra: {
      replyTo: t.in_reply_to_screen_name,
      quoted: t.quoted_tweet?.id_str,
      ...(conversation ? { threadPosts: conversation.thread.length, repliesRead: conversation.replyCount, conversationVia: conversation.via } : {}),
      ...(conversation?.note ? { note: conversation.note } : {}),
    },
    provenance: prov({
      tier: Tier.Native, adapter: 'twitter',
      strategy: conversation && conversation.via !== 'none' ? `syndication cdn + ${conversation.via}` : 'syndication cdn',
      finalUrl: canonical, httpStatus: 200,
    }),
  });
  void url;
}

function buildMedia(t: SyndicationTweet) {
  const out: { type: 'image' | 'video' | 'gif'; url: string; alt?: string; width?: number; height?: number; durationSec?: number }[] = [];
  for (const p of t.photos ?? []) out.push({ type: 'image', url: p.url, width: p.width, height: p.height });
  for (const m of t.mediaDetails ?? []) {
    if (m.type === 'photo' && !out.some((o) => o.url === m.media_url_https)) {
      out.push({ type: 'image', url: m.media_url_https, alt: m.ext_alt_text });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      out.push({
        type: m.type === 'animated_gif' ? 'gif' : 'video',
        url: m.media_url_https,
        durationSec: m.video_info?.duration_millis ? Math.round(m.video_info.duration_millis / 1000) : undefined,
      });
    }
  }
  if (t.video?.variants?.length && !out.some((o) => o.type === 'video')) {
    const best = t.video.variants.filter((v) => v.type === 'video/mp4').pop() ?? t.video.variants[0]!;
    out.push({ type: 'video', url: best.src, durationSec: t.video.durationMs ? Math.round(t.video.durationMs / 1000) : undefined });
  }
  return out;
}

async function viaOembed(id: string, url: URL, ctx: AdapterContext): Promise<Document> {
  const json = await ctx.http.json<{ html: string; author_name: string; author_url: string; url: string }>(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.href)}&omit_script=1&dnt=1`,
    { timeoutMs: ctx.options.timeoutMs, retries: 1 },
  );
  const text = json.html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  const handle = /x\.com\/([^/]+)/.exec(json.author_url)?.[1] ?? json.author_name;
  return makeDoc({
    url: json.url ?? url.href,
    source: 'twitter',
    nativeId: id,
    kind: 'post',
    title: truncate(text, 90),
    text,
    author: { handle, name: json.author_name, url: json.author_url },
    provenance: prov({ tier: Tier.Native, adapter: 'twitter', strategy: 'publish oembed', finalUrl: json.url ?? url.href, httpStatus: 200 }),
  });
}

/** A profile: bio and counts, then its posts, newest first. */
async function profileDoc(handle: string, ctx: AdapterContext, url: URL): Promise<Document> {
  if (await sessionForHost('x.com')) {
    try {
      return await sessionProfileDoc(handle, ctx);
    } catch (err) {
      ctx.log.debug(`saved-login profile for @${handle} failed: ${(err as Error).message}; using the public feed`);
    }
  }
  const { user, tweets } = await profileTimeline(handle, ctx);
  const h = user?.screen_name ?? handle;
  const canonical = `https://x.com/${h}`;
  const newestFirst = [...tweets].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const posts = newestFirst.map((t) => {
    const r = timelineResult(t);
    const e = r.engagement ?? {};
    const when = r.publishedAt?.slice(0, 10) ?? '';
    const reply = t.in_reply_to_screen_name ? ` · reply to @${t.in_reply_to_screen_name}` : '';
    return `### ${when}${reply}\n\n${r.snippet}\n\n_❤️ ${human(e.score)} · 💬 ${human(e.comments)} · 🔁 ${human(e.shares)} · [open](${r.url})_`;
  });
  const header = [
    `**${user?.name ?? h}** (@${h})${user?.is_blue_verified || user?.verified ? ' ✓' : ''}`,
    user?.description ? `\n${decodeEntities(user.description)}` : '',
    user ? `\n_${human(user.followers_count)} followers · ${human(user.friends_count)} following · ${human(user.statuses_count)} posts${user.location ? ` · ${user.location}` : ''}_` : '',
  ].join('');
  return makeDoc({
    url: canonical,
    source: 'twitter',
    nativeId: user?.id_str,
    kind: 'profile',
    title: `${user?.name ?? h} (@${h})`,
    text: `${header}\n\n## Posts (${tweets.length}, newest first)\n\n${posts.join('\n\n---\n\n')}`,
    excerpt: user?.description ? truncate(decodeEntities(user.description), 280) : undefined,
    author: { handle: h, name: user?.name, url: canonical, avatar: user?.profile_image_url_https, verified: user?.is_blue_verified ?? user?.verified, followers: user?.followers_count },
    extra: { posts: tweets.length, note: 'The posts X shows logged out (usually the most recent), replies included, reposts left out.' },
    provenance: prov({ tier: Tier.Native, adapter: 'twitter', strategy: 'profile timeline (syndication)', finalUrl: canonical, httpStatus: 200 }),
  });
  void url;
}

/** A profile read with your saved login: the newest posts, with views. */
async function sessionProfileDoc(handle: string, ctx: AdapterContext): Promise<Document> {
  const { sessionProfile } = await import('./x-conversation.js');
  const posts = (await sessionProfile(handle, ctx)).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  if (!posts.length) throw new Error('no posts captured');
  const a = posts[0]!.author;
  const canonical = `https://x.com/${a.handle}`;
  const body = posts.map((p) => {
    const reply = p.replyToHandle ? ` · reply to @${p.replyToHandle}` : '';
    const views = p.views !== undefined ? ` · 👁 ${human(p.views)}` : '';
    return `### ${p.createdAt?.slice(0, 10) ?? ''}${reply}\n\n${p.text}\n\n_❤️ ${human(p.likes)} · 💬 ${human(p.replies)} · 🔁 ${human((p.reposts ?? 0) + (p.quotes ?? 0))}${views} · [open](https://x.com/${a.handle}/status/${p.id})_`;
  });
  return makeDoc({
    url: canonical,
    source: 'twitter',
    nativeId: a.id,
    kind: 'profile',
    title: `${a.name ?? a.handle} (@${a.handle})`,
    text: `**${a.name ?? a.handle}** (@${a.handle})${a.verified ? ' ✓' : ''}${a.followers !== undefined ? `\n_${human(a.followers)} followers_` : ''}\n\n## Posts (${posts.length}, newest first)\n\n${body.join('\n\n---\n\n')}`,
    author: { handle: a.handle, name: a.name, url: canonical, verified: a.verified, followers: a.followers },
    extra: { posts: posts.length, note: 'Read with your saved X login (scour login x).' },
    provenance: prov({ tier: Tier.Headless, adapter: 'twitter', strategy: 'profile (your saved login)', finalUrl: canonical, httpStatus: 200 }),
  });
}

/** A trailing t.co link on a tweet with media is just the media link; drop it. Also unescape HTML entities. */
function cleanText(text: string, hasMedia: boolean): string {
  const t = hasMedia ? text.replace(/\s*https?:\/\/t\.co\/\w+\s*$/, '') : text;
  return decodeEntities(t).trim();
}

/** The syndication API returns tweet text HTML-escaped ("&gt;", "&amp;"). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function expandUrls(text: string, urls?: { expanded_url: string; display_url: string }[]): string {
  let out = text;
  for (const u of urls ?? []) {
    // t.co links are opaque; swap in the real destination.
    out = out.replace(new RegExp(`https?://t\\.co/\\w+`), u.expanded_url);
  }
  return out.trim();
}

export function tweetId(url: URL): string | null {
  return /\/status(?:es)?\/(\d+)/.exec(url.pathname)?.[1] ?? null;
}
