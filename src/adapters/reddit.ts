import * as cheerio from 'cheerio';
import { extractFromHtml, normDate } from '../core/extract.js';
import { parseFeed } from './rss.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type SearchResult,
} from '../core/types.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';

/**
 * Reddit.
 *
 * Reddit rate-limits anonymous JSON hard from datacenter IPs but serves it
 * fine to ordinary clients. We walk three free hosts before considering
 * OAuth (free app credentials) and never require a login to read.
 */
const JSON_HOSTS = ['https://www.reddit.com'];

/** Remember for a while that anonymous JSON is blocked from this IP, so we stop paying for 190 KB block pages. */
const JSON_BLOCK_KEY = 'route:reddit:json-blocked';
const JSON_BLOCK_TTL = 6 * 3600;

interface RedditThing<T> { kind: string; data: T }
interface RedditPost {
  id: string; name: string; title: string; selftext: string; author: string;
  subreddit: string; subreddit_name_prefixed: string; permalink: string; url: string;
  score: number; num_comments: number; upvote_ratio: number; created_utc: number;
  over_18: boolean; link_flair_text?: string; is_self: boolean; post_hint?: string;
  edited?: number | boolean; stickied?: boolean; total_awards_received?: number;
}
interface RedditComment {
  id: string; author: string; body: string; score: number; created_utc: number;
  permalink: string; replies?: '' | { data: { children: RedditThing<RedditComment>[] } };
  stickied?: boolean; is_submitter?: boolean; distinguished?: string | null;
}

export const redditAdapter: Adapter = {
  name: 'reddit',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)reddit\.com$/.test(url.hostname) || url.hostname === 'redd.it';
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const path = url.pathname.replace(/\/$/, '');
    const isComments = /\/comments\//.test(path);
    const depth = typeof ctx.options.comments === 'number' ? ctx.options.comments : ctx.options.comments === false ? 0 : 200;
    const errors: string[] = [];

    // Rung 1+2: official JSON (OAuth if configured, else anonymous).
    if (ctx.config.credentials.reddit || !(await ctx.cache.get(JSON_BLOCK_KEY))) {
      const query = isComments
        ? `?limit=${Math.min(depth || 100, 500)}&depth=8&raw_json=1&sort=top`
        : '?limit=50&raw_json=1';
      try {
        const { body, host } = await fetchRedditJson(`${path}/.json${query}`, ctx);
        return isComments ? buildThread(body, url, host, ctx, depth) : buildListing(body, url, host);
      } catch (err) {
        errors.push((err as Error).message.split('\n')[0]!);
      }
    } else {
      ctx.log.debug('reddit: skipping JSON (learned: blocked from this IP)');
    }

    // Rung 3: the server-rendered fragments reddit.com itself loads.
    try {
      return isComments ? await threadViaPartials(url, ctx, depth) : await listingViaPartials(url, ctx);
    } catch (err) {
      errors.push(`partials: ${(err as Error).message}`);
    }

    // Rung 4: Atom feed.
    try {
      const feedUrl = `https://www.reddit.com${path}/.rss`;
      const res = await ctx.http.get(feedUrl, { timeoutMs: ctx.options.timeoutMs, retries: 1 });
      const doc = parseFeed(res.body, url.href);
      doc.source = 'reddit';
      doc.provenance = prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'atom feed', finalUrl: feedUrl, httpStatus: res.status, bytes: res.bytes });
      return doc;
    } catch (err) {
      errors.push(`rss: ${(err as Error).message}`);
    }

    throw new TierError(`Every free Reddit route failed:\n  ${errors.join('\n  ')}`, Tier.Native);
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit), sort: 'relevance', t: 'year', raw_json: '1', type: 'link' });
    if (ctx.config.credentials.reddit || !(await ctx.cache.get(JSON_BLOCK_KEY))) {
      try {
        const { body } = await fetchRedditJson(`/search.json?${params}`, ctx);
        const listing = body as { data?: { children?: RedditThing<RedditPost>[] } };
        return (listing.data?.children ?? []).map((c) => ({
          title: c.data.title,
          url: `https://www.reddit.com${c.data.permalink}`,
          snippet: truncate(c.data.selftext.replace(/\s+/g, ' '), 300) || undefined,
          source: 'reddit',
          publishedAt: normDate(c.data.created_utc),
          author: { handle: c.data.author, url: `https://www.reddit.com/user/${c.data.author}` },
          engagement: { score: c.data.score, comments: c.data.num_comments, ratio: c.data.upvote_ratio },
          extra: { subreddit: c.data.subreddit_name_prefixed },
        }));
      } catch {
        // fall through
      }
    }
    try {
      const res = await ctx.http.get(`https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&type=link&sort=relevance&t=year`, {
        timeoutMs: ctx.options.timeoutMs, retries: 1,
      });
      const feed = parseFeed(res.body, 'https://www.reddit.com/search');
      const hits = (feed.children ?? []).slice(0, limit).map((d) => ({
        title: d.title ?? d.url, url: d.url, snippet: d.excerpt, source: 'reddit',
        publishedAt: d.publishedAt, author: d.author ? { handle: d.author.name?.replace(/^\/u\//, '') } : undefined,
      }));
      if (hits.length) return hits;
    } catch {
      // fall through
    }
    // Last resort: let the web search engines do it.
    const { webSearchAdapter } = await import('../search/websearch.js');
    const web = await webSearchAdapter.search!(`site:reddit.com ${query}`, ctx, limit);
    return web.filter((r) => /reddit\.com\/r\//.test(r.url)).map((r) => ({ ...r, source: 'reddit' }));
  },

  async health(ctx: AdapterContext): Promise<HealthReport> {
    try {
      await fetchRedditJson('/r/programming/hot/.json?limit=1&raw_json=1', ctx);
      return {
        adapter: 'reddit',
        status: 'ready',
        detail: 'Official JSON reachable from this IP.',
        capabilities: ['read post', 'read comments', 'read subreddit', 'search'],
      };
    } catch (err) {
      const partials = await listingViaPartials(new URL('https://www.reddit.com/r/programming/'), ctx).then(() => true, () => false);
      if (partials) {
        return {
          adapter: 'reddit',
          status: 'ready',
          detail: 'JSON is blocked from this IP, so scour uses the page-fragment route instead. Threads, comments and subreddits all work.',
          fix: 'Optional: REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (free script app) restores exact vote counts on posts and native search.',
          capabilities: ['read post', 'read comments', 'read subreddit', 'search (via feed/web)'],
        };
      }
      return {
        adapter: 'reddit',
        status: 'degraded',
        detail: `JSON and page fragments both blocked from this IP (${(err as Error).message.split('\n')[0]}).`,
        fix:
          'Run from a residential connection, set SCOUR_PROXY, or create a free script app at https://www.reddit.com/prefs/apps ' +
          'and set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET.',
        capabilities: ['headless fallback'],
      };
    }
  },
};

/** Try each free host in turn; OAuth only if the user supplied free app creds. */
async function fetchRedditJson(pathAndQuery: string, ctx: AdapterContext): Promise<{ body: unknown; host: string }> {
  const errors: string[] = [];

  if (ctx.config.credentials.reddit) {
    try {
      const token = await redditToken(ctx);
      const body = await ctx.http.json(`https://oauth.reddit.com${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': `scour/0.1 by script-app` },
        timeoutMs: ctx.options.timeoutMs,
      });
      return { body, host: 'oauth.reddit.com' };
    } catch (err) {
      errors.push(`oauth: ${(err as Error).message}`);
    }
  }

  for (const host of JSON_HOSTS) {
    try {
      const body = await ctx.http.json(`${host}${pathAndQuery}`, {
        timeoutMs: ctx.options.timeoutMs,
        retries: 1,
        headers: { Accept: 'application/json' },
        proxy: ctx.options.proxy,
      });
      return { body, host };
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${new URL(host).host}: ${msg}`);
      if (/\b403\b/.test(msg) && !ctx.options.proxy) await ctx.cache.set(JSON_BLOCK_KEY, true, JSON_BLOCK_TTL);
    }
  }

  throw new TierError(
    `All free Reddit endpoints refused this request.\n  ${errors.join('\n  ')}\n` +
      '  Fix: set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (free, 1 min at reddit.com/prefs/apps) or use --max-tier headless.',
    Tier.Native,
  );
}

async function redditToken(ctx: AdapterContext): Promise<string> {
  const creds = ctx.config.credentials.reddit!;
  const cacheKey = `reddit:token:${creds.clientId}`;
  const hit = await ctx.cache.get<{ token: string }>(cacheKey);
  if (hit) return hit.value.token;

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await ctx.http.post('https://www.reddit.com/api/v1/access_token', 'grant_type=client_credentials', {
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeoutMs: ctx.options.timeoutMs,
  });
  const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number; error?: string };
  if (!json.access_token) throw new Error(`Reddit token request failed: ${json.error ?? res.body.slice(0, 120)}`);
  // Refresh a minute before Reddit expires it.
  await ctx.cache.set(cacheKey, { token: json.access_token }, Math.max((json.expires_in ?? 3600) - 60, 60));
  return json.access_token;
}

function buildThread(body: unknown, url: URL, host: string, ctx: AdapterContext, depth: number): Document {
  const parts = body as [{ data: { children: RedditThing<RedditPost>[] } }, { data: { children: RedditThing<RedditComment>[] } }];
  const post = parts[0]?.data?.children?.[0]?.data;
  if (!post) throw new TierError('Reddit returned no post for this URL.', Tier.Native, false);

  const comments = depth === 0 ? [] : (parts[1]?.data?.children ?? [])
    .filter((c) => c.kind === 't1')
    .map((c) => toComment(c.data))
    .slice(0, depth || 200);

  const head = [
    `# ${post.title}`,
    '',
    `**${post.subreddit_name_prefixed}** · u/${post.author} · ${human(post.score)} points ` +
      `(${Math.round((post.upvote_ratio ?? 0) * 100)}% upvoted) · ${human(post.num_comments)} comments` +
      (post.link_flair_text ? ` · _${post.link_flair_text}_` : ''),
    '',
  ];
  if (!post.is_self && post.url && post.url !== url.href) head.push(`🔗 ${post.url}`, '');
  if (post.selftext) head.push(post.selftext.trim(), '');
  if (comments.length) head.push('---', '', `## Comments (${comments.length} top-level)`, '', renderThread(comments));

  void ctx;
  return makeDoc({
    url: `https://www.reddit.com${post.permalink}`,
    source: 'reddit',
    nativeId: post.id,
    kind: 'post',
    title: post.title,
    text: head.join('\n').trim(),
    excerpt: truncate(post.selftext.replace(/\s+/g, ' '), 280) || undefined,
    author: { handle: post.author, url: `https://www.reddit.com/user/${post.author}` },
    publishedAt: normDate(post.created_utc),
    updatedAt: typeof post.edited === 'number' ? normDate(post.edited) : undefined,
    engagement: { score: post.score, comments: post.num_comments, ratio: post.upvote_ratio },
    tags: [post.subreddit_name_prefixed, post.link_flair_text].filter((x): x is string => !!x),
    links: post.is_self ? [] : [{ url: post.url, external: true }],
    children: comments,
    extra: { subreddit: post.subreddit, nsfw: post.over_18, awards: post.total_awards_received },
    provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: `${host} json`, finalUrl: url.href, httpStatus: 200 }),
  });
}

function toComment(c: RedditComment): Document {
  const replies =
    c.replies && typeof c.replies === 'object'
      ? (c.replies.data.children ?? []).filter((x) => x.kind === 't1').map((x) => toComment(x.data))
      : [];
  return makeDoc({
    url: `https://www.reddit.com${c.permalink ?? ''}`,
    source: 'reddit',
    nativeId: c.id,
    kind: 'comment',
    text: (c.body ?? '').trim(),
    author: { handle: c.author },
    publishedAt: normDate(c.created_utc),
    engagement: { score: c.score },
    children: replies.length ? replies : undefined,
    extra: c.is_submitter ? { opAuthor: true } : undefined,
    provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'embedded', finalUrl: `https://www.reddit.com${c.permalink ?? ''}` }),
  });
}

function buildListing(body: unknown, url: URL, host: string): Document {
  const listing = body as { data?: { children?: RedditThing<RedditPost>[] } };
  const posts = (listing.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => c.data);
  const name = url.pathname.replace(/\/$/, '') || '/';
  const lines = posts.map(
    (p, i) =>
      `${i + 1}. **[${p.title}](https://www.reddit.com${p.permalink})**\n` +
      `   u/${p.author} · ${human(p.score)} pts · ${human(p.num_comments)} comments` +
      (p.link_flair_text ? ` · _${p.link_flair_text}_` : '') +
      (p.selftext ? `\n   > ${truncate(p.selftext.replace(/\s+/g, ' '), 180)}` : ''),
  );
  return makeDoc({
    url: url.href,
    source: 'reddit',
    kind: 'listing',
    title: `Reddit ${name}`,
    text: [`# Reddit ${name}`, '', ...lines].join('\n'),
    children: posts.map((p) =>
      makeDoc({
        url: `https://www.reddit.com${p.permalink}`,
        source: 'reddit', nativeId: p.id, kind: 'post', title: p.title,
        text: p.selftext ?? '',
        author: { handle: p.author },
        publishedAt: normDate(p.created_utc),
        engagement: { score: p.score, comments: p.num_comments, ratio: p.upvote_ratio },
        provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'listing', finalUrl: `https://www.reddit.com${p.permalink}` }),
      }),
    ),
    provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: `${host} listing`, finalUrl: url.href, httpStatus: 200 }),
  });
}

// ---------------------------------------------------------------------------
// Page-fragment route. These are the same server-rendered HTML partials that
// reddit.com loads into its own pages; they carry structured attributes
// (author, score, depth, parent id) so no guessing is needed.
// ---------------------------------------------------------------------------

async function threadViaPartials(url: URL, ctx: AdapterContext, depth: number): Promise<Document> {
  const m = /\/r\/([^/]+)\/comments\/([a-z0-9]+)/i.exec(url.pathname);
  if (!m) throw new Error('not a thread URL');
  const [, sub, id] = m as unknown as [string, string, string];
  const canonical = `https://www.reddit.com/r/${sub}/comments/${id}/`;

  const [meta, commentsHtml, feed] = await Promise.all([
    ctx.http.json<{ title?: string; author_name?: string; html?: string }>(
      `https://www.reddit.com/oembed?url=${encodeURIComponent(canonical)}`,
      { timeoutMs: ctx.options.timeoutMs, retries: 1 },
    ).catch(() => null),
    depth === 0
      ? Promise.resolve('')
      : ctx.http.get(`https://www.reddit.com/svc/shreddit/comments/r/${sub}/t3_${id}?sort=top`, {
          timeoutMs: ctx.options.timeoutMs, retries: 1,
        }).then((r) => r.body).catch(() => ''),
    // The Atom feed is the only fragment-free source of the post body; best-effort.
    ctx.http.get(`https://www.reddit.com/r/${sub}/comments/${id}/.rss`, { timeoutMs: ctx.options.timeoutMs, retries: 0 })
      .then((r) => parseFeed(r.body, canonical)).catch(() => null),
  ]);

  const title = meta?.title ?? feed?.children?.[0]?.title;
  if (!title && !commentsHtml) throw new Error('oembed and comment fragment both empty');

  const comments = commentsHtml ? parseCommentFragment(commentsHtml, depth) : [];
  const op = feed?.children?.[0];
  const selftext = (op?.text ?? '')
    .replace(/submitted by\s+\/u\/\S+.*$/s, '')
    // Link/image posts arrive wrapped in a one-row thumbnail table.
    .replace(/^\|[\s|]*\|\s*/gm, '')
    .replace(/^\|?\s*-{3}[\s|-]*$/gm, '')
    .replace(/\s*\|\s*$/gm, '')
    .trim();
  const author = meta?.author_name ?? op?.author?.name?.replace(/^\/u\//, '');
  const total = countTree(comments);

  const body = [`# ${title ?? id}`, '', `**r/${sub}** · u/${author ?? 'unknown'} · ${total} comments loaded`, ''];
  if (selftext) body.push(selftext, '');
  if (comments.length) body.push('---', '', `## Comments`, '', renderThread(comments));

  return makeDoc({
    url: canonical,
    source: 'reddit',
    nativeId: id,
    kind: 'post',
    title,
    text: body.join('\n').trim(),
    excerpt: truncate(selftext.replace(/\s+/g, ' '), 280) || undefined,
    author: author ? { handle: author, url: `https://www.reddit.com/user/${author}` } : undefined,
    publishedAt: op?.publishedAt,
    engagement: { comments: total },
    tags: [`r/${sub}`],
    children: comments,
    extra: { subreddit: sub, bodySource: selftext ? 'atom' : 'unavailable' },
    provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'oembed + comment fragment' + (selftext ? ' + atom' : ''), finalUrl: canonical, httpStatus: 200 }),
  });
}

export function parseCommentFragment(html: string, limit = 500): Document[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Document>();
  const roots: Document[] = [];
  $('shreddit-comment').each((_, el) => {
    if (byId.size >= limit) return;
    const a = (el as unknown as { attribs: Record<string, string> }).attribs;
    const thingId = a.thingid;
    if (!thingId) return;
    const bodyEl = $(`#${thingId}-comment-rtjson-content`).first();
    const bodyHtml = bodyEl.length ? bodyEl.html() ?? '' : $(el).find('[slot="comment"]').first().html() ?? '';
    const text = bodyHtml ? htmlToMd(bodyHtml) : '[deleted]';
    const doc = makeDoc({
      url: a.permalink ? `https://www.reddit.com${a.permalink}` : '',
      source: 'reddit',
      nativeId: thingId.replace(/^t1_/, ''),
      kind: 'comment',
      text,
      author: { handle: a.author || '[deleted]' },
      publishedAt: normDate(a.created),
      engagement: { score: a.score !== undefined ? Number(a.score) : undefined },
      provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'comment fragment', finalUrl: a.permalink ? `https://www.reddit.com${a.permalink}` : '' }),
    });
    byId.set(thingId, doc);
    const parent = a.parentid ? byId.get(a.parentid) : undefined;
    if (parent) (parent.children ??= []).push(doc);
    else roots.push(doc);
  });
  return roots;
}

async function listingViaPartials(url: URL, ctx: AdapterContext): Promise<Document> {
  const m = /^\/r\/([^/]+)(?:\/(hot|new|top|rising))?/i.exec(url.pathname);
  if (!m) throw new Error('only subreddit listings have a fragment route');
  const sub = m[1]!;
  const sort = (m[2] ?? 'hot').toLowerCase();
  const res = await ctx.http.get(`https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/?name=${encodeURIComponent(sub)}`, {
    timeoutMs: ctx.options.timeoutMs, retries: 1,
  });
  const $ = cheerio.load(res.body);
  const posts: Document[] = [];
  $('shreddit-post').each((_, el) => {
    const a = (el as unknown as { attribs: Record<string, string> }).attribs;
    if (!a.permalink || !a['post-title']) return;
    posts.push(makeDoc({
      url: `https://www.reddit.com${a.permalink}`,
      source: 'reddit',
      nativeId: (a.id ?? '').replace(/^t3_/, '') || undefined,
      kind: 'post',
      title: decodeEntities(a['post-title']),
      text: '',
      author: { handle: a.author },
      publishedAt: normDate(a['created-timestamp']),
      engagement: {
        score: num(a.score), comments: num(a['comment-count']),
        ratio: a['upvote-ratio'] ? Number(a['upvote-ratio']) : undefined,
      },
      links: a['content-href'] && !a['content-href'].includes(a.permalink) ? [{ url: a['content-href'], external: true }] : [],
      extra: { postType: a['post-type'], domain: a.domain },
      provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'listing fragment', finalUrl: `https://www.reddit.com${a.permalink}` }),
    }));
  });
  if (posts.length === 0) throw new Error('listing fragment had no posts');

  const lines = posts.map((p, i) =>
    `${i + 1}. **[${p.title}](${p.url})**\n   u/${p.author?.handle} · ${human(p.engagement?.score)} pts · ${human(p.engagement?.comments)} comments` +
    (p.links?.[0] ? `\n   🔗 ${p.links[0].url}` : ''));
  return makeDoc({
    url: url.href,
    source: 'reddit',
    kind: 'listing',
    title: `r/${sub} · ${sort}`,
    text: [`# r/${sub} · ${sort}`, '', ...lines].join('\n'),
    children: posts,
    provenance: prov({ tier: Tier.Native, adapter: 'reddit', strategy: 'listing fragment', finalUrl: url.href, httpStatus: res.status, bytes: res.bytes }),
  });
}

function countTree(nodes: Document[]): number {
  return nodes.reduce((n, c) => n + 1 + countTree(c.children ?? []), 0);
}

function htmlToMd(html: string): string {
  try {
    return extractFromHtml(`<div id="c">${html}</div>`, 'https://www.reddit.com', { selector: '#c', collectLinks: false }).text;
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function num(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : undefined;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
