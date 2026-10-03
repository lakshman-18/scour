import { normDate } from '../core/extract.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document, type MediaItem, type SearchResult } from '../core/types.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';

/**
 * Bluesky via its public AppView API: posts, full reply threads, profiles and
 * recent posts. No account, no key. (Bluesky's own search endpoint now
 * requires login, so topic search goes through search-engine indexes.)
 */
const API = 'https://public.api.bsky.app/xrpc';

interface BskyAuthor { did: string; handle: string; displayName?: string; avatar?: string; followersCount?: number }
interface BskyPost {
  uri: string;
  author: BskyAuthor;
  record: { text?: string; createdAt?: string };
  embed?: {
    images?: { fullsize: string; alt?: string }[];
    external?: { uri: string; title?: string; description?: string };
    record?: { author?: BskyAuthor; value?: { text?: string } };
  };
  likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number;
}
interface ThreadNode { post?: BskyPost; replies?: ThreadNode[] }

export const blueskyAdapter: Adapter = {
  name: 'bluesky',
  priority: 50,

  match(url: URL): boolean {
    return /^(www\.)?bsky\.app$/.test(url.hostname);
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const m = /^\/profile\/([^/]+)(?:\/post\/([^/]+))?/.exec(url.pathname);
    if (!m) throw new TierError(`Not a Bluesky profile or post URL: ${url.href}`, Tier.Native, false);
    const [, actor, rkey] = m as unknown as [string, string, string | undefined];
    return rkey ? thread(actor, rkey, ctx, url) : profile(actor, ctx, url);
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const { webSearchAdapter } = await import('../search/websearch.js');
    const hits = await webSearchAdapter.search!(`site:bsky.app ${query}`, ctx, Math.min(limit * 2, 20));
    const posts = hits.filter((h) => /bsky\.app\/profile\/[^/]+\/post\//.test(h.url)).slice(0, limit);
    const out: SearchResult[] = [];
    for (const h of posts) {
      try {
        const d = await blueskyAdapter.fetch(new URL(h.url), { ...ctx, options: { ...ctx.options, comments: 0 } });
        out.push({
          title: truncate(d.text.replace(/\s+/g, ' '), 100), url: d.url, snippet: d.excerpt, source: 'bluesky',
          publishedAt: d.publishedAt, author: d.author, engagement: d.engagement, extra: { via: 'search-engine index' },
        });
      } catch {
        // deleted or unreachable post; skip
      }
    }
    return out;
  },
};

async function did(actor: string, ctx: AdapterContext): Promise<string> {
  if (actor.startsWith('did:')) return actor;
  const r = await ctx.http.json<{ did: string }>(`${API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`, { timeoutMs: ctx.options.timeoutMs });
  return r.did;
}

async function thread(actor: string, rkey: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const uri = `at://${await did(actor, ctx)}/app.bsky.feed.post/${rkey}`;
  const depth = ctx.options.comments === false || ctx.options.comments === 0 ? 0 : 6;
  const r = await ctx.http.json<{ thread: ThreadNode }>(
    `${API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=${depth}&parentHeight=0`,
    { timeoutMs: ctx.options.timeoutMs },
  );
  const root = r.thread.post;
  if (!root) throw new TierError('Bluesky returned no post (deleted or blocked).', Tier.Native, false);
  const replies = (r.thread.replies ?? []).map(toReply).filter((x): x is Document => !!x);
  const body = postText(root);
  const text = [
    `**${root.author.displayName ?? root.author.handle}** (@${root.author.handle})`, '', body, '',
    `_❤️ ${human(root.likeCount)} · 🔁 ${human((root.repostCount ?? 0) + (root.quoteCount ?? 0))} · 💬 ${human(root.replyCount)}_`,
    ...(replies.length ? ['', '---', '', '## Replies', '', renderThread(replies)] : []),
  ].join('\n');
  return makeDoc({
    url: postUrl(root), source: 'bluesky', nativeId: root.uri, kind: 'post',
    title: truncate(root.record.text?.replace(/\s+/g, ' '), 90), text,
    excerpt: truncate(root.record.text?.replace(/\s+/g, ' '), 280),
    author: authorOf(root.author), publishedAt: normDate(root.record.createdAt),
    engagement: { score: root.likeCount, comments: root.replyCount, shares: (root.repostCount ?? 0) + (root.quoteCount ?? 0) },
    media: mediaOf(root), children: replies,
    links: root.embed?.external ? [{ url: root.embed.external.uri, text: root.embed.external.title, external: true }] : [],
    provenance: prov({ tier: Tier.Native, adapter: 'bluesky', strategy: 'public appview thread', finalUrl: url.href, httpStatus: 200 }),
  });
}

function toReply(n: ThreadNode): Document | null {
  if (!n.post) return null;
  const kids = (n.replies ?? []).map(toReply).filter((x): x is Document => !!x);
  return makeDoc({
    url: postUrl(n.post), source: 'bluesky', nativeId: n.post.uri, kind: 'comment',
    text: postText(n.post), author: { handle: n.post.author.handle, name: n.post.author.displayName },
    publishedAt: normDate(n.post.record.createdAt), engagement: { score: n.post.likeCount },
    children: kids.length ? kids : undefined,
    provenance: prov({ tier: Tier.Native, adapter: 'bluesky', strategy: 'embedded', finalUrl: postUrl(n.post) }),
  });
}

async function profile(actor: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const [p, feed] = await Promise.all([
    ctx.http.json<BskyAuthor & { description?: string; postsCount?: number; followsCount?: number }>(
      `${API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { timeoutMs: ctx.options.timeoutMs }),
    ctx.http.json<{ feed: { post: BskyPost }[] }>(
      `${API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=25&filter=posts_no_replies`, { timeoutMs: ctx.options.timeoutMs },
    ).catch(() => ({ feed: [] as { post: BskyPost }[] })),
  ]);
  const posts = feed.feed.map((f) => f.post);
  const lines = posts.map((x) => `- ${x.record.createdAt?.slice(0, 10)} · ❤️ ${human(x.likeCount)} — ${truncate(x.record.text?.replace(/\s+/g, ' '), 200)}\n  ${postUrl(x)}`);
  return makeDoc({
    url: `https://bsky.app/profile/${p.handle}`, source: 'bluesky', nativeId: p.did, kind: 'profile',
    title: p.displayName ?? p.handle,
    text: [`# ${p.displayName ?? p.handle} (@${p.handle})`, '', p.description ?? '', '',
      `${human(p.followersCount)} followers · ${human(p.postsCount)} posts`, '', '## Recent posts', '', ...lines].join('\n'),
    author: authorOf(p), engagement: { score: p.followersCount },
    children: posts.map((x) => makeDoc({
      url: postUrl(x), source: 'bluesky', nativeId: x.uri, kind: 'post', title: truncate(x.record.text?.replace(/\s+/g, ' '), 90),
      text: postText(x), author: authorOf(x.author), publishedAt: normDate(x.record.createdAt),
      engagement: { score: x.likeCount, comments: x.replyCount, shares: x.repostCount },
      provenance: prov({ tier: Tier.Native, adapter: 'bluesky', strategy: 'author feed', finalUrl: postUrl(x) }),
    })),
    provenance: prov({ tier: Tier.Native, adapter: 'bluesky', strategy: 'public appview profile', finalUrl: url.href, httpStatus: 200 }),
  });
}

function postText(p: BskyPost): string {
  const parts = [p.record.text ?? ''];
  const e = p.embed;
  if (e?.external) parts.push(`\n🔗 [${e.external.title ?? e.external.uri}](${e.external.uri})`);
  if (e?.record?.value?.text) parts.push(`\n> **Quoting @${e.record.author?.handle}:** ${e.record.value.text.replace(/\n/g, '\n> ')}`);
  for (const img of e?.images ?? []) parts.push(`\n![${img.alt ?? 'image'}](${img.fullsize})`);
  return parts.join('\n').trim();
}

function mediaOf(p: BskyPost): MediaItem[] {
  return (p.embed?.images ?? []).map((i) => ({ type: 'image' as const, url: i.fullsize, alt: i.alt }));
}

function authorOf(a: BskyAuthor) {
  return { handle: a.handle, name: a.displayName, url: `https://bsky.app/profile/${a.handle}`, avatar: a.avatar, followers: a.followersCount };
}

function postUrl(p: BskyPost): string {
  return `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`;
}
