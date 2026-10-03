import { normDate } from '../core/extract.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type SearchResult,
} from '../core/types.js';
import { human, makeDoc, prov, truncate } from './_helpers.js';
import { ALLOWANCES, costOf, recordUsage } from '../core/usage.js';
import { genericAdapter } from './generic.js';

/**
 * Twitter / X.
 *
 * Reading a single tweet needs no account: the syndication endpoint that powers
 * every embedded tweet on the web serves the full object as JSON. Search and
 * timelines genuinely require a session, so we ask for cookies only then — and
 * only ones the user exported themselves.
 */
export const twitterAdapter: Adapter = {
  name: 'twitter',
  priority: 50,

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

    // 2. Your own session cookies, if you chose to add them.
    const creds = ctx.config.credentials.twitter;
    if (creds) {
      try {
        const live = await sessionSearch(query, ctx, limit, creds);
        if (live.length) return live;
      } catch (err) {
        ctx.log.warn(`X session search failed (${(err as Error).message.split('\n')[0]}); using the search-engine route`);
      }
    }
    return indexedSearch(query, ctx, limit);
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
 * Topic search without a login: search engines index public tweets, so we ask
 * them for x.com status URLs and then read each tweet in full through the
 * syndication endpoint (exact text, likes, replies, media, timestamp).
 * Not real-time — coverage is whatever the engines have indexed, typically
 * popular tweets from hours to days ago.
 */
async function indexedSearch(query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const { webSearchAdapter } = await import('../search/websearch.js');
  const hits = await webSearchAdapter.search!(`site:x.com ${query}`, ctx, Math.min(limit * 3, 30));
  const ids: string[] = [];
  for (const h of hits) {
    try {
      const id = tweetId(new URL(h.url));
      if (id && !ids.includes(id)) ids.push(id);
    } catch {
      // not a URL we can read
    }
  }
  if (ids.length === 0) {
    throw new TierError(
      'Search engines returned no tweet URLs for this query. X search without a login relies on what engines have indexed; ' +
        'for live search run `scour auth twitter`.',
      Tier.Native,
    );
  }
  const settled = await Promise.allSettled(ids.slice(0, limit).map((id) => syndicationJson(id, ctx)));
  const out: SearchResult[] = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value?.user) continue;
    const t = s.value;
    out.push({
      title: truncate(decodeEntities(t.text ?? '').replace(/\s+/g, ' '), 100),
      url: `https://x.com/${t.user!.screen_name}/status/${t.id_str}`,
      snippet: cleanText(expandUrls(t.text ?? '', t.entities?.urls), (t.photos?.length ?? 0) + (t.mediaDetails?.length ?? 0) > 0),
      source: 'twitter',
      publishedAt: normDate(t.created_at),
      author: { handle: t.user!.screen_name, name: t.user!.name, verified: t.user!.is_blue_verified ?? t.user!.verified },
      engagement: { score: t.favorite_count, comments: t.conversation_count },
      extra: { via: 'search-engine index + syndication' },
    });
  }
  return out;
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
    try {
      await syndicationJson('1', ctx).catch(() => null); // reachability probe only
    } catch {
      // ignore
    }
    return {
      adapter: 'twitter',
      status: creds ? 'ready' : 'degraded',
      detail: creds
        ? 'Session cookies present (unofficial; risks the account). Indexed search is the fallback.'
        : ctx.config.providers.xBearerToken
          ? 'Official X API configured: live search when --max-cost allows ($0.005/post). Indexed search otherwise.'
          : 'Tweets read in full with no account. Topic search uses search-engine indexes (popular tweets, not real-time).',
      fix: ctx.config.providers.xBearerToken || creds ? undefined : 'For live, complete search with no account risk: the official X API, pay-per-use ($0.005/post): `scour auth x-api`.',
      capabilities: ['read tweet', 'indexed search', ...(ctx.config.providers.xBearerToken ? ['live search (paid)'] : creds ? ['live search (session)'] : [])],
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
  user?: { screen_name: string; name: string; profile_image_url_https?: string; verified?: boolean; is_blue_verified?: boolean };
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
  return ctx.http.json<SyndicationTweet>(url, {
    timeoutMs: ctx.options.timeoutMs,
    retries: 1,
    headers: { Accept: 'application/json', Referer: 'https://platform.twitter.com/' },
  });
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

  return makeDoc({
    url: canonical,
    source: 'twitter',
    nativeId: t.id_str ?? id,
    kind: 'post',
    title: truncate(decodeEntities(t.text ?? '').replace(/\s+/g, ' '), 90),
    text: `${header}\n\n${body}\n\n_${stats}_`,
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
    links: (t.entities?.urls ?? []).map((u) => ({ url: u.expanded_url, text: u.display_url, external: true })),
    tags: (t.entities?.hashtags ?? []).map((h) => `#${h.text}`),
    extra: { replyTo: t.in_reply_to_screen_name, quoted: t.quoted_tweet?.id_str },
    provenance: prov({ tier: Tier.Native, adapter: 'twitter', strategy: 'syndication cdn', finalUrl: canonical, httpStatus: 200 }),
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

async function profileDoc(handle: string, ctx: AdapterContext, url: URL): Promise<Document> {
  throw new TierError(
    `Reading @${handle}'s timeline needs a session. Run \`scour auth twitter\`, or read a single tweet URL instead (that works with no login).`,
    Tier.Native,
  );
  void ctx; void url;
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
