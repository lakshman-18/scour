import { load } from 'cheerio';
import { normDate } from '../core/extract.js';
import { Tier, TierError, type AdapterContext, type Document, type SearchResult } from '../core/types.js';
import { costOf, recordUsage } from '../core/usage.js';
import { sessionForHost } from '../render/sessions.js';
import { makeDoc, prov, truncate } from './_helpers.js';
import { postsFromGraphql, type XPost } from './x-graphql.js';

/**
 * Replies and threads under an X post. Logged out, X shows only the post
 * itself, so the routes are, in order:
 *
 * 1. The official X API, when configured and the spending cap allows it.
 * 2. Your saved login (`scour login x`): a browser with your session opens the
 *    post, as you would, and we read the replies X's page loads.
 * 3. Thread Reader App: a public copy of the author's own thread (their
 *    replies to themselves), if anyone has asked it to unroll the thread.
 *    Free, but it never has other people's replies.
 */
export interface Conversation {
  /** The author's own continuation of the post, in order. */
  thread: XPost[];
  /** Everyone's replies, as a tree. */
  replies: Document[];
  replyCount: number;
  via: string;
  /** Said to the reader when replies could not be read. */
  note?: string;
}

export async function readConversation(
  focal: { id: string; handle: string; replies?: number },
  ctx: AdapterContext,
  limit = 100,
): Promise<Conversation> {
  const problems: string[] = [];
  const token = ctx.config.providers.xBearerToken;
  if (token) {
    const worst = await costOf('x-api-posts', Math.min(Math.max(limit, 10), 100));
    if (ctx.budget.canAfford(worst)) {
      try {
        return shape(focal, await apiConversation(focal.id, ctx, token, Math.min(Math.max(limit, 10), 100)), 'official X API');
      } catch (err) {
        problems.push(`X API: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  const session = await sessionForHost('x.com');
  if (session) {
    try {
      const posts = await sessionPosts(`https://x.com/${focal.handle}/status/${focal.id}`, /\/TweetDetail\b/, ctx, Math.min(8, Math.ceil(limit / 15)));
      if (posts.length) return shape(focal, posts, 'your saved X login');
      problems.push('your saved X login showed no replies (the session may have expired: run `scour login x` again)');
    } catch (err) {
      problems.push(`saved login: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  const thread = await threadReader(focal.id, focal.handle, ctx).catch(() => [] as XPost[]);
  const others = Math.max(0, (focal.replies ?? 0) - thread.length);
  const how = session ? problems.join('; ') : 'X shows replies only to logged-in visitors. Run `scour login x` to read them with your own account';
  return {
    thread,
    replies: [],
    replyCount: 0,
    via: thread.length ? 'Thread Reader App (the author\'s thread only)' : 'none',
    note: others > 0 ? `${others} ${others === 1 ? 'reply' : 'replies'} from other people not shown: ${how}.` : undefined,
  };
}

/** Split a conversation into the author's own thread and everyone else's reply tree. */
function shape(focal: { id: string; handle: string }, posts: XPost[], via: string): Conversation {
  const focalPost = posts.find((p) => p.id === focal.id);
  const conv = focalPost?.conversationId ?? focal.id;
  const inConv = posts.filter((p) => p.id !== focal.id && (p.conversationId === conv || p.replyToId === focal.id) && !p.isRepost);
  const author = (focalPost?.author.handle ?? focal.handle).toLowerCase();

  // The thread: the author replying to their own previous part, from the top.
  const thread: XPost[] = [];
  let cursor = focal.id;
  for (;;) {
    const next = inConv.find((p) => p.replyToId === cursor && p.author.handle.toLowerCase() === author && !thread.includes(p));
    if (!next) break;
    thread.push(next);
    cursor = next.id;
  }
  const threadIds = new Set([focal.id, ...thread.map((p) => p.id)]);
  const rest = inConv.filter((p) => !threadIds.has(p.id));
  const byParent = new Map<string, XPost[]>();
  for (const p of rest) {
    const k = p.replyToId && rest.some((r) => r.id === p.replyToId) ? p.replyToId : 'root';
    byParent.set(k, [...(byParent.get(k) ?? []), p]);
  }
  const build = (p: XPost, depth: number): Document => {
    const kids = depth < 6 ? (byParent.get(p.id) ?? []).sort(byLikes).map((c) => build(c, depth + 1)) : [];
    return makeDoc({
      url: `https://x.com/${p.author.handle}/status/${p.id}`,
      source: 'twitter',
      nativeId: p.id,
      kind: 'comment',
      text: p.text,
      author: { handle: p.author.handle, name: p.author.name, verified: p.author.verified, followers: p.author.followers },
      publishedAt: p.createdAt,
      engagement: { score: p.likes, comments: p.replies, shares: (p.reposts ?? 0) + (p.quotes ?? 0) || undefined, views: p.views },
      children: kids.length ? kids : undefined,
      provenance: prov({ tier: Tier.Native, adapter: 'twitter', strategy: via, finalUrl: `https://x.com/${p.author.handle}/status/${p.id}` }),
    });
  };
  const replies = (byParent.get('root') ?? []).sort(byLikes).map((p) => build(p, 0));
  return { thread, replies, replyCount: rest.length, via };
}

const byLikes = (a: XPost, b: XPost) => (b.likes ?? 0) - (a.likes ?? 0);

/** Official X API recent search for the conversation (last 7 days, billed per post). */
async function apiConversation(id: string, ctx: AdapterContext, token: string, pageSize: number): Promise<XPost[]> {
  const params = new URLSearchParams({
    query: `conversation_id:${id}`,
    max_results: String(pageSize),
    'tweet.fields': 'created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets',
    expansions: 'author_id',
    'user.fields': 'username,name,verified,public_metrics',
  });
  const json = await ctx.http.json<{
    data?: { id: string; text: string; author_id: string; created_at?: string; conversation_id?: string; referenced_tweets?: { type: string; id: string }[]; public_metrics?: Record<string, number> }[];
    includes?: { users?: { id: string; username: string; name: string; verified?: boolean; public_metrics?: { followers_count?: number } }[] };
  }>(`https://api.x.com/2/tweets/search/recent?${params}`, { timeoutMs: ctx.options.timeoutMs, retries: 0, headers: { Authorization: `Bearer ${token}` } });
  const rows = json.data ?? [];
  ctx.budget.charge(await costOf('x-api-posts', rows.length), 'x api conversation');
  await recordUsage('x-api-posts', rows.length);
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  return rows.map((t) => {
    const u = users.get(t.author_id);
    const m = t.public_metrics ?? {};
    return {
      id: t.id, text: t.text, createdAt: normDate(t.created_at), conversationId: t.conversation_id,
      replyToId: t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id,
      likes: m.like_count, replies: m.reply_count, reposts: m.retweet_count, quotes: m.quote_count, views: m.impression_count,
      author: { handle: u?.username ?? 'unknown', name: u?.name, verified: u?.verified, followers: u?.public_metrics?.followers_count },
      media: [], links: [], isRepost: false,
    } satisfies XPost;
  });
}

/**
 * Open an X page with your saved login and collect the posts its own data
 * requests return (TweetDetail, SearchTimeline, UserTweets…).
 */
export async function sessionPosts(url: string, capture: RegExp, ctx: AdapterContext, scrolls = 2): Promise<XPost[]> {
  const session = await sessionForHost('x.com');
  if (!session) throw new TierError('No saved X login. Run `scour login x` first.', Tier.Headless, false);
  const page = await ctx.render(url, {
    session: { key: session.key, dir: session.dir, channel: session.meta.channel },
    captureResponses: capture,
    captureCount: 1,
    scroll: scrolls,
    waitUntil: 'domcontentloaded',
    timeoutMs: Math.max(ctx.options.timeoutMs, 30_000),
  });
  if (/\/i\/flow\/login|\/login\b/.test(page.url)) {
    throw new TierError('X sent the saved session to its login page; the login has expired. Run `scour login x` again.', Tier.Headless, false);
  }
  const posts = new Map<string, XPost>();
  for (const c of page.captured ?? []) {
    try {
      for (const p of postsFromGraphql(JSON.parse(c.body))) if (!posts.has(p.id)) posts.set(p.id, p);
    } catch {
      // not JSON (an error page); skip
    }
  }
  return [...posts.values()];
}

/** Search X as your logged-in self: live, complete, with view counts. */
export async function sessionSearch(query: string, ctx: AdapterContext, limit: number, latest = false): Promise<SearchResult[]> {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${latest ? '&f=live' : ''}`;
  const posts = await sessionPosts(url, /\/SearchTimeline\b/, ctx, Math.min(6, Math.ceil(limit / 15)));
  return posts.filter((p) => !p.isRepost).slice(0, Math.max(limit * 2, limit)).map((p) => postToResult(p, 'your saved X login (live search)'));
}

/** An account's newest posts, as you see them logged in. */
export async function sessionProfile(handle: string, ctx: AdapterContext): Promise<XPost[]> {
  const posts = await sessionPosts(`https://x.com/${handle}`, /\/UserTweets\b/, ctx, 2);
  return posts.filter((p) => !p.isRepost && p.author.handle.toLowerCase() === handle.toLowerCase());
}

export function postToResult(p: XPost, via: string): SearchResult {
  return {
    title: truncate(p.text.replace(/\s+/g, ' '), 100),
    url: `https://x.com/${p.author.handle}/status/${p.id}`,
    snippet: p.text,
    source: 'twitter',
    publishedAt: p.createdAt,
    author: { handle: p.author.handle, name: p.author.name, verified: p.author.verified, followers: p.author.followers },
    engagement: { score: p.likes, comments: p.replies, shares: (p.reposts ?? 0) + (p.quotes ?? 0), views: p.views },
    extra: { via, ...(p.replyToHandle ? { replyTo: p.replyToHandle } : {}) },
  };
}

/**
 * The author's own thread from Thread Reader App, a public site that keeps
 * copies of threads people have asked it to unroll. Only /thread/<id>.html is
 * read, which its robots.txt allows.
 */
export async function threadReader(id: string, handle: string, ctx: AdapterContext): Promise<XPost[]> {
  const res = await ctx.http.get(`https://threadreaderapp.com/thread/${id}.html`, {
    timeoutMs: Math.min(ctx.options.timeoutMs, 15_000),
    retries: 0,
    allowStatus: [404, 410],
  });
  if (res.status >= 400) return [];
  return parseThreadReader(res.body, id, handle);
}

export function parseThreadReader(html: string, id: string, handle: string): XPost[] {
  const $ = load(html);
  const seen = new Set<string>();
  const posts: XPost[] = [];
  $('.content-tweet[data-tweet]').each((_i, el) => {
    const e = $(el);
    const pid = e.attr('data-tweet')!;
    const who = e.attr('data-screenname') ?? handle;
    if (seen.has(pid) || who.toLowerCase() !== handle.toLowerCase()) return;
    seen.add(pid);
    const links: string[] = [];
    e.find('a.entity-url[href]').each((_j, a) => {
      const href = $(a).attr('href')!;
      links.push(href);
      $(a).replaceWith(` ${href} `);
    });
    const media: XPost['media'] = [];
    e.find('img[src*="pbs.twimg.com/media"]').each((_j, img) => void media.push({ type: 'image', url: $(img).attr('src')! }));
    e.find('video[poster]').each((_j, v) => void media.push({ type: 'video', url: $(v).attr('poster')! }));
    e.find('sup, .entity-video, .entity-image, script, style').remove();
    e.find('br').replaceWith('\n');
    const text = e.text().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    posts.push({ id: pid, text, author: { handle: who }, media, links, isRepost: false });
  });
  // The first block is the post itself; the rest is the thread, in order.
  return posts.filter((p) => p.id !== id);
}
