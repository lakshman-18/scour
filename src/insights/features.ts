/**
 * What kind of post is this? Cheap, deterministic traits that can be compared
 * across hundreds of posts: format, hook style, length, structure, timing.
 */
export interface PostLike {
  text: string;
  createdAt?: string;
  media?: { type: string }[];
  isArticle?: boolean;
  hasQuote?: boolean;
  links?: number;
  isReply?: boolean;
}

export interface Features {
  format: 'article' | 'video' | 'image' | 'quote' | 'link' | 'text';
  hook: 'announcement' | 'how-to' | 'list' | 'hot-take' | 'question' | 'story' | 'data' | 'news/leak' | 'other';
  length: 'short (<100)' | 'medium (100–280)' | 'long (280+)';
  structure: 'list/thread-style' | 'single block';
  numbers: 'has numbers/stats' | 'no numbers';
  emoji: 'emoji' | 'no emoji';
  hashtags: 'hashtags' | 'no hashtags';
  daypart?: 'morning (6–12)' | 'afternoon (12–18)' | 'evening (18–24)' | 'night (0–6)';
  weekday?: string;
}

export const DIMENSIONS: { key: keyof Features; label: string }[] = [
  { key: 'format', label: 'Format' },
  { key: 'hook', label: 'Opening style' },
  { key: 'length', label: 'Length' },
  { key: 'structure', label: 'Structure' },
  { key: 'numbers', label: 'Numbers & stats' },
  { key: 'emoji', label: 'Emoji' },
  { key: 'hashtags', label: 'Hashtags' },
  { key: 'daypart', label: 'Time posted' },
  { key: 'weekday', label: 'Day posted' },
];

const HOOKS: [Features['hook'], RegExp][] = [
  ['news/leak', /\b(leak(ed|s)?|rumou?r|reportedly|according to|spotted|scoop|sources say)\b/i],
  ['announcement', /^(breaking|introducing|announcing|launch(ing|ed)?|today we|we('re| are) (launching|releasing)|just (dropped|released|launched|shipped)|new:|now available|meet )/i],
  ['how-to', /^(how (to|i|we)|here'?s how|a guide|step[- ]by[- ]step|tutorial|the (complete|full|ultimate) guide)/i],
  ['list', /^(\d+|top \d+|ten|five|three|seven)\b.{0,40}\b(things|ways|tips|tools|lessons|reasons|mistakes|ideas|prompts|steps)\b/i],
  ['hot-take', /\b(unpopular opinion|hot take|controversial|overrated|underrated|nobody (is talking|talks)|stop (using|doing)|is dead|wrong about)\b/i],
  ['data', /(\d+(\.\d+)?\s?%|\b\d+(\.\d+)?x\b|\$\d|\bbenchmark|\bstats?\b|\bdata\b)/i],
  ['story', /^(i |i'?ve |i was |i spent |my |last (week|month|year)|when i )/i],
];

export function extractFeatures(p: PostLike, timeZone?: string): Features {
  const text = p.text.trim();
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const media = (p.media ?? []).map((m) => m.type);

  const format: Features['format'] = p.isArticle ? 'article'
    : media.some((t) => t === 'video' || t === 'gif') ? 'video'
    : media.includes('image') ? 'image'
    : p.hasQuote ? 'quote'
    : (p.links ?? 0) > 0 ? 'link'
    : 'text';

  let hook: Features['hook'] = 'other';
  for (const [name, re] of HOOKS) {
    if (name === 'news/leak' || name === 'hot-take' || name === 'data' ? re.test(text.slice(0, 280)) : re.test(firstLine)) {
      hook = name;
      break;
    }
  }
  if (hook === 'other' && /\?\s*$/.test(firstLine)) hook = 'question';

  const len = text.replace(/https?:\/\/\S+/g, '').length;
  const lines = text.split('\n').filter((l) => l.trim());
  const listLines = lines.filter((l) => /^\s*([-•→*–]|\d+[.)]|[①-⑩]|[✅❌👉🔹▪️])\s*/u.test(l)).length;

  const f: Features = {
    format,
    hook,
    length: len < 100 ? 'short (<100)' : len <= 280 ? 'medium (100–280)' : 'long (280+)',
    structure: listLines >= 2 || lines.length >= 5 ? 'list/thread-style' : 'single block',
    numbers: /\d/.test(text.replace(/https?:\/\/\S+/g, '')) ? 'has numbers/stats' : 'no numbers',
    emoji: /\p{Extended_Pictographic}/u.test(text) ? 'emoji' : 'no emoji',
    hashtags: /(^|\s)#\w/.test(text) ? 'hashtags' : 'no hashtags',
  };

  if (p.createdAt) {
    const d = new Date(p.createdAt);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, weekday: 'short', timeZone }).formatToParts(d);
      const hour = Number(parts.find((x) => x.type === 'hour')?.value ?? 0) % 24;
      f.daypart = hour < 6 ? 'night (0–6)' : hour < 12 ? 'morning (6–12)' : hour < 18 ? 'afternoon (12–18)' : 'evening (18–24)';
      f.weekday = parts.find((x) => x.type === 'weekday')?.value;
    }
  }
  return f;
}
