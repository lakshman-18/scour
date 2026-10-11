/**
 * Posts out of the JSON X's own web app loads (TweetDetail, SearchTimeline,
 * UserTweets…). We never call those endpoints ourselves: a logged-in browser
 * page does, exactly as it does for you, and we read the responses. The
 * parser walks the JSON for post objects instead of following one fixed
 * layout, so it survives X reshuffling its response format.
 */
export interface XPost {
  id: string;
  text: string;
  createdAt?: string;
  conversationId?: string;
  replyToId?: string;
  replyToHandle?: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
  author: { handle: string; name?: string; verified?: boolean; followers?: number; id?: string };
  media: { type: 'image' | 'video' | 'gif'; url: string }[];
  links: string[];
  isRepost: boolean;
  quoted?: { id: string; handle?: string; text: string };
}

type Json = Record<string, any>;

export function postsFromGraphql(json: unknown): XPost[] {
  const out = new Map<string, XPost>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    const o = node as Json;
    if (o.__typename === 'TweetWithVisibilityResults' && o.tweet) return visit(o.tweet);
    if (typeof o.rest_id === 'string' && o.legacy && typeof o.legacy.full_text === 'string') {
      const p = toPost(o);
      if (p && !out.has(p.id)) out.set(p.id, p);
      return; // quoted and reposted posts inside it are not separate results
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(json);
  return [...out.values()];
}

function toPost(o: Json): XPost | null {
  const l = o.legacy as Json;
  const u = o.core?.user_results?.result as Json | undefined;
  const handle: string | undefined = u?.core?.screen_name ?? u?.legacy?.screen_name;
  if (!handle) return null;
  const urls: { url: string; expanded_url: string }[] = l.entities?.urls ?? [];
  const media: Json[] = l.extended_entities?.media ?? l.entities?.media ?? [];
  let text: string = o.note_tweet?.note_tweet_results?.result?.text ?? l.full_text;
  for (const x of urls) if (x.url && x.expanded_url) text = text.split(x.url).join(x.expanded_url);
  // The trailing t.co link on a post with media is just the media itself.
  for (const m of media) if (m.url) text = text.split(m.url).join('');
  const q = o.quoted_status_result?.result as Json | undefined;
  const quoted = q?.__typename === 'TweetWithVisibilityResults' ? q.tweet : q;
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    id: o.rest_id,
    text: decode(text).trim(),
    createdAt: l.created_at ? new Date(l.created_at).toISOString() : undefined,
    conversationId: l.conversation_id_str,
    replyToId: l.in_reply_to_status_id_str || undefined,
    replyToHandle: l.in_reply_to_screen_name || undefined,
    likes: num(l.favorite_count),
    replies: num(l.reply_count),
    reposts: num(l.retweet_count),
    quotes: num(l.quote_count),
    views: num(o.views?.count),
    bookmarks: num(l.bookmark_count),
    author: {
      handle,
      name: u?.core?.name ?? u?.legacy?.name,
      verified: u?.is_blue_verified ?? u?.legacy?.verified,
      followers: num(u?.legacy?.followers_count ?? u?.relationship_counts?.followers),
      id: u?.rest_id,
    },
    media: media.map((m) => ({
      type: m.type === 'video' ? 'video' : m.type === 'animated_gif' ? 'gif' : 'image',
      url: m.media_url_https,
    })),
    links: urls.map((x) => x.expanded_url).filter(Boolean),
    isRepost: !!l.retweeted_status_result || /^RT @\w+:/.test(l.full_text),
    quoted: quoted?.legacy
      ? { id: quoted.rest_id, handle: quoted.core?.user_results?.result?.core?.screen_name ?? quoted.core?.user_results?.result?.legacy?.screen_name, text: decode(quoted.legacy.full_text ?? '') }
      : undefined,
  };
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
