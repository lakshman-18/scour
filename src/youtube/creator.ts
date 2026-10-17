import type { Scour } from '../core/pipeline.js';
import type { Document } from '../core/types.js';
import { fmtTime, ytDlp, type Chapter, type Segment, type VideoInfo } from '../adapters/video.js';
import { STOPWORDS } from '../core/query.js';

/**
 * YouTube creator tools (the ideas in youtube-agent-skill), as measurements
 * rather than prose: scour finds and scores, your AI writes. Every tool is
 * deterministic and free:
 *
 *   hook       score an opening line on five properties
 *   title      lint a title and thumbnail text as one pairing
 *   chapters   propose chapters from where the topic shifts; check them against YouTube's rules
 *   edit       an edit decision list: dead air, filler words, retakes, with timecodes
 *   shorts     the Shorts already inside a long video, ranked by what viewers replay
 *   comments   the comment section in piles: questions, requests, praise, criticism, spam; which to pin
 *   outliers   videos in a niche ranked by how far they beat their own channel's median
 *   keywords   what people actually type into YouTube search about a topic
 *   retention  a YouTube Studio retention export: hook leak, cliffs, and what was said there
 *   audit      a channel's recent videos: hits, misses, and the title patterns behind them
 */

export interface Timeline {
  segments: Segment[];
  heatmap: { start: number; end: number; value: number }[];
  chapters: Chapter[];
  duration?: number;
  comments: VideoInfo['comments'];
}

/** A video (URL) or audio/video file, read with its timed data. */
export async function loadTimeline(scour: Scour, input: string, comments = 0): Promise<{ doc: Document; t: Timeline }> {
  const { isLocalFile, readLocalFile } = await import('../core/files.js');
  const doc = (await isLocalFile(input))
    ? await readLocalFile(input)
    : await scour.get(input, { comments: comments || false, adapterOptions: { timeline: true, keepSponsors: true } });
  const t = doc.extra?.timeline as Timeline | undefined;
  if (!t) throw new Error(`${input} is not a video scour can read with timings (YouTube links and local audio/video files work).`);
  return { doc, t };
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Everyday English that says nothing about a topic, for chapter labels. */
const COMMON = new Set(('about above after again against all also am an any are around as at back be because been before being below between both but by can cannot could did do does doing done down during each even every few first for from further get gets getting go goes going gonna got had has have having he her here hers him his how however i i\'m i\'ve if in into is it it\'s its just kind know let like look lot make many may me might more most much must my need new no not now of off on once one only or other our out over own really right said same say see she should show so some something still such take than that that\'s the their them then there these they thing things think this those through to too two uh um under until up us use used very want was way we well were what when where which while who why will with would yeah you your you\'re actually basically maybe okay ok sort pretty quite want wanna').split(' '));
const meaningful = (w: string) => w.length > 3 && !STOPWORDS.has(w) && !COMMON.has(w) && !/^\d+$/.test(w);

// ------------------------------------------------------------------ hook

export interface HookScore {
  line: string;
  score: number;
  checks: { name: string; pass: boolean; why: string }[];
}

const THROAT_CLEARING = /^(hey|hi|hello|what'?s up|welcome( back)?|in (this|today'?s) video|today,? (i|we)|so,? |before we (start|begin)|let'?s get (started|into)|alright|okay|ok,? )/i;
const GAP = /\b(why|how|secret|nobody|no one|mistake|wrong|actually|truth|stop|never|hidden|real reason|what happens|until|turns out|here'?s|the one)\b|\?/i;
const OUTCOME = /\b(save|make|earn|lose|grow|get|build|fix|avoid|double|triple|faster|cheaper|free|without|in \d+|minutes?|days?|hours?|\$|%)\b/i;

/** Five properties of an opening line that holds attention. */
export function scoreHook(line: string): HookScore {
  const w = words(line);
  const checks = [
    { name: 'short', pass: w.length > 0 && w.length <= 14, why: w.length <= 14 ? `${w.length} words, said in under 5 seconds` : `${w.length} words; aim for 14 or fewer` },
    { name: 'no throat-clearing', pass: !THROAT_CLEARING.test(line.trim()), why: THROAT_CLEARING.test(line.trim()) ? 'starts with a greeting or "in this video"; open on the point instead' : 'opens on the point' },
    { name: 'specific', pass: /\d|\$|%/.test(line) || /\s[A-Z][a-z]+/.test(line.slice(1)), why: /\d|\$|%/.test(line) ? 'has a concrete number' : /\s[A-Z][a-z]+/.test(line.slice(1)) ? 'names something concrete' : 'add a number, name or concrete detail' },
    { name: 'curiosity gap', pass: GAP.test(line), why: GAP.test(line) ? 'raises a question the video answers' : 'nothing makes the viewer need the next sentence' },
    { name: 'stakes for the viewer', pass: /\b(you|your)\b/i.test(line) || OUTCOME.test(line), why: /\b(you|your)\b/i.test(line) || OUTCOME.test(line) ? 'says what the viewer gets or risks' : 'say what the viewer gains or loses' },
  ];
  return { line, score: checks.filter((c) => c.pass).length, checks };
}

// ------------------------------------------------------------------ title + thumbnail

export interface TitleLint {
  title: string;
  thumbnail?: string;
  issues: { severity: 'fix' | 'consider'; message: string }[];
  mobileView: string;
}

const VAGUE = /\b(this|that|these|things?|stuff|insane|crazy|amazing|unbelievable|you won'?t believe|shocking|epic)\b/gi;

/** Title and thumbnail are read together; lint them as one pairing. */
export function lintTitle(title: string, thumbnail?: string): TitleLint {
  const issues: TitleLint['issues'] = [];
  const t = title.trim();
  if (t.length > 70) issues.push({ severity: 'fix', message: `${t.length} characters: cut off after about 70 in search results` });
  else if (t.length > 55) issues.push({ severity: 'consider', message: `${t.length} characters: phones show about 55; make sure the first 55 carry it` });
  if (t.length < 20) issues.push({ severity: 'consider', message: 'very short: there is room to say what the viewer gets' });
  const caps = t.split(/\s+/).filter((x) => x.length > 3 && x === x.toUpperCase() && /[A-Z]/.test(x));
  if (caps.length > 2) issues.push({ severity: 'consider', message: `${caps.length} words in capitals reads as shouting; keep one for emphasis` });
  const vague = [...new Set(t.match(VAGUE)?.map((v) => v.toLowerCase()) ?? [])];
  if (vague.length) issues.push({ severity: 'consider', message: `vague words (${vague.join(', ')}): replace with the specific thing` });
  if (!/\d/.test(t) && !/\?/.test(t) && !/\b(how|why|what)\b/i.test(t)) issues.push({ severity: 'consider', message: 'no number, question or how/why: these give a reason to click' });
  if (/[!?]{2,}/.test(t)) issues.push({ severity: 'consider', message: 'stacked !? look like clickbait' });
  if (thumbnail) {
    const tw = words(thumbnail);
    if (tw.length > 5) issues.push({ severity: 'fix', message: `thumbnail text is ${tw.length} words; 2–4 words read at a glance` });
    const titleWords = new Set(words(t).filter((x) => !STOPWORDS.has(x)));
    const shared = tw.filter((x) => !STOPWORDS.has(x) && titleWords.has(x));
    if (tw.length && shared.length / tw.length >= 0.5) {
      issues.push({ severity: 'fix', message: `thumbnail repeats the title (${shared.join(', ')}); let it add something the title doesn't say` });
    }
  }
  return { title: t, thumbnail, issues, mobileView: t.length > 55 ? `${t.slice(0, 54)}…` : t };
}

// ------------------------------------------------------------------ chapters

/** YouTube shows chapters only if: the first is at 0:00, there are at least 3, each lasts 10 s or more, in order. */
export function checkChapters(text: string, duration?: number): { chapters: Chapter[]; problems: string[] } {
  const chapters: Chapter[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\(?(\d{1,2}(?::\d{2}){1,2})\)?\s*[-–—:]?\s*(.+)$/.exec(line);
    if (!m) continue;
    const start = m[1]!.split(':').map(Number).reduce((s, p) => s * 60 + p, 0);
    chapters.push({ start, end: 0, title: m[2]!.trim() });
  }
  chapters.forEach((c, i) => (c.end = chapters[i + 1]?.start ?? duration ?? c.start));
  const problems: string[] = [];
  if (!chapters.length) problems.push('no timestamps found (lines like "0:00 Intro")');
  else {
    if (chapters[0]!.start !== 0) problems.push(`the first chapter starts at ${fmtTime(chapters[0]!.start)}; YouTube needs 0:00`);
    if (chapters.length < 3) problems.push(`${chapters.length} chapters; YouTube needs at least 3`);
    chapters.forEach((c, i) => {
      if (i && c.start <= chapters[i - 1]!.start) problems.push(`"${c.title}" (${fmtTime(c.start)}) is not after the previous chapter`);
      if (c.end - c.start < 10 && (i < chapters.length - 1 || duration)) problems.push(`"${c.title}" lasts ${Math.max(0, c.end - c.start)} s; each chapter needs 10 s or more`);
      if (duration && c.start >= duration) problems.push(`"${c.title}" starts after the video ends`);
    });
  }
  return { chapters, problems };
}

/**
 * Propose chapters where the vocabulary changes (TextTiling): compare the
 * words in the minute before and after each point, cut at the deepest dips,
 * keep chapters between ~1 and ~10 minutes, and label each with its most
 * distinctive words for your AI (or you) to turn into a title.
 */
export function suggestChapters(segments: Segment[], duration?: number, target?: number): Chapter[] {
  if (!segments.length) return [];
  const end = duration ?? segments.at(-1)!.end;
  const want = target ?? Math.min(12, Math.max(3, Math.round(end / 240)));
  const step = 15;
  const bag = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (const s of segments) if (s.start >= from && s.start < to) for (const w of words(s.text)) if (meaningful(w)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const cos = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [k, v] of a) { na += v * v; dot += v * (b.get(k) ?? 0); }
    for (const v of b.values()) nb += v * v;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  const points: { at: number; sim: number }[] = [];
  for (let at = 60; at < end - 60; at += step) points.push({ at, sim: cos(bag(at - 75, at), bag(at, at + 75)) });
  const minGap = Math.max(60, end / (want * 2.5));
  const cuts: number[] = [];
  for (const p of [...points].sort((a, b) => a.sim - b.sim)) {
    if (cuts.length >= want - 1) break;
    if (cuts.some((c) => Math.abs(c - p.at) < minGap)) continue;
    // Start the chapter at the beginning of the sentence nearest the dip.
    const seg = segments.reduce((best, s) => (Math.abs(s.start - p.at) < Math.abs(best.start - p.at) ? s : best));
    cuts.push(Math.round(seg.start));
  }
  // No chapter far longer than the rest: split long stretches at their deepest dip.
  const maxLen = (end / want) * 1.8;
  for (let guard = 0; guard < want; guard++) {
    const bounds = [0, ...cuts.sort((a, b) => a - b), end];
    const i = bounds.findIndex((b, k) => k < bounds.length - 1 && bounds[k + 1]! - b > maxLen);
    if (i < 0) break;
    const inside = points.filter((p) => p.at > bounds[i]! + 60 && p.at < bounds[i + 1]! - 60).sort((a, b) => a.sim - b.sim)[0];
    if (!inside) break;
    cuts.push(Math.round(segments.reduce((best, s) => (Math.abs(s.start - inside.at) < Math.abs(best.start - inside.at) ? s : best)).start));
  }
  const starts = [0, ...cuts.sort((a, b) => a - b)];
  const all = bag(0, end);
  return starts.map((start, i) => {
    const stop = starts[i + 1] ?? end;
    const local = bag(start, stop);
    // Distinctive: frequent here, rarer elsewhere.
    const top = [...local.entries()]
      .map(([w, n]) => ({ w, s: n * Math.log(1 + (all.get(w) ?? 1) / Math.max(1, (all.get(w) ?? 0) - n + 1)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.w);
    return { start, end: stop, title: i === 0 ? `Intro${top.length ? ` (${top.join(', ')})` : ''}` : top.join(', ') || `Part ${i + 1}` };
  });
}

// ------------------------------------------------------------------ edit decision list

const FILLER_WORDS = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'ah']);
const FILLER_PHRASES = /\b(um+|uh+|erm|you know|i mean|sort of|kind of|basically|literally|like,)\b/gi;

export interface EditCue {
  at: number;
  end: number;
  kind: 'dead air' | 'filler' | 'retake';
  note: string;
}

/** Dead air, filler words and retakes, with timecodes, in order. */
export function editDecisionList(segments: Segment[], opts: { gap?: number } = {}): { cues: EditCue[]; fillerCount: number; deadAirSec: number } {
  const cues: EditCue[] = [];
  const gap = opts.gap ?? 1.5;
  let fillerCount = 0;
  let deadAirSec = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const next = segments[i + 1];
    if (next && next.start - s.end >= gap) {
      cues.push({ at: s.end, end: next.start, kind: 'dead air', note: `${(next.start - s.end).toFixed(1)} s of silence` });
      deadAirSec += next.start - s.end;
    }
    const fillers = s.text.match(FILLER_PHRASES) ?? [];
    if (fillers.length) {
      fillerCount += fillers.length;
      if (fillers.length >= 2 || /^(um+|uh+)\b/i.test(s.text)) cues.push({ at: s.start, end: s.end, kind: 'filler', note: `${fillers.map((f) => f.toLowerCase()).join(', ')}: "${s.text.slice(0, 80)}"` });
    }
    // A retake: a four-word phrase said again within 30 s (fillers ignored).
    const grams = ngrams(s.text, 4);
    const again = segments.slice(i + 1).find((x) => x.start - s.start <= 30 && ngrams(x.text, 4).some((g) => grams.includes(g)));
    if (again) {
      const phrase = ngrams(again.text, 4).find((g) => grams.includes(g))!;
      cues.push({ at: s.start, end: again.start, kind: 'retake', note: `"${phrase}" is said again at ${fmtTime(again.start)}; keep the later take` });
    }
  }
  return { cues: cues.sort((a, b) => a.at - b.at), fillerCount, deadAirSec: Math.round(deadAirSec) };
}

function ngrams(text: string, n: number): string[] {
  const w = words(text).filter((x) => !FILLER_WORDS.has(x) && !['so', 'like', 'okay', 'ok'].includes(x));
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

// ------------------------------------------------------------------ shorts

export interface ShortClip {
  start: number;
  end: number;
  replay: number;
  firstLine: string;
  text: string;
  why: string[];
  cut: string;
}

/**
 * The Shorts already inside a long video: 20–58 s windows that start on a
 * sentence (not "and", "so", "but"), ranked by how much viewers replay that
 * stretch (YouTube's heatmap) and whether the first line works as a hook.
 */
export function findShorts(t: Timeline, url: string, n = 5): ShortClip[] {
  const segs = t.segments;
  if (!segs.length) return [];
  const replayAt = (a: number, b: number) => {
    const inside = t.heatmap.filter((h) => h.end > a && h.start < b);
    return inside.length ? inside.reduce((s, h) => s + h.value, 0) / inside.length : 0;
  };
  type Scored = ShortClip & { score: number };
  const clips: Scored[] = [];
  for (let i = 0; i < segs.length; i++) {
    const first = segs[i]!;
    if (/^(and|so|but|because|or|which|that|then|to|of|the)\b/i.test(first.text) || first.start < 5) continue;
    // Auto captions have no punctuation: a clean start follows a pause, a
    // finished sentence, or a chapter boundary.
    const prev = segs[i - 1];
    const clean = !prev || first.start - prev.end >= 0.4 || /[.!?]["')]?$/.test(prev.text) || t.chapters.some((c) => Math.abs(c.start - first.start) < 2);
    if (!clean && clips.length > 0 && i % 2) continue;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1]!.end - first.start <= 58) j++;
    const end = segs[j]!.end;
    if (end - first.start < 20) continue;
    const opening = segs.slice(i, j + 1).map((s) => s.text).join(' ').split(/\s+/).slice(0, 18).join(' ');
    const hook = scoreHook(opening);
    const replay = replayAt(first.start, end);
    const whole = /[.!?]$/.test(segs[j]!.text);
    clips.push({
      start: first.start,
      end,
      replay: Math.round(replay * 100) / 100,
      firstLine: `${opening}…`,
      text: segs.slice(i, j + 1).map((s) => s.text).join(' '),
      why: [
        ...(replay ? [`replayed ${Math.round(replay * 100)}% as much as the most replayed moment`] : []),
        `opening line scores ${hook.score}/5 as a hook`,
        ...(clean ? ['starts at a natural break'] : []),
        ...(whole ? ['ends on a full sentence'] : []),
      ],
      cut: '',
      score: replay * 3 + hook.score / 5 + (whole ? 0.2 : 0) + (clean ? 0.4 : 0),
    });
  }
  const picked: Scored[] = [];
  for (const c of clips.sort((a, b) => b.score - a.score)) {
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    c.cut = /^https?:/.test(url)
      ? `yt-dlp --download-sections "*${fmtTime(c.start)}-${fmtTime(c.end)}" -f "bv*+ba/b" "${url}"`
      : `ffmpeg -ss ${c.start.toFixed(1)} -to ${c.end.toFixed(1)} -i "${url}" -c copy short.mp4`;
    picked.push(c);
    if (picked.length >= n) break;
  }
  return picked.map(({ score: _score, ...c }) => c);
}

// ------------------------------------------------------------------ comments

export type Pile = 'question' | 'request' | 'praise' | 'criticism' | 'spam' | 'other';

export function classifyComment(text: string): Pile {
  const t = text.toLowerCase();
  if (/(t\.me\/|telegram|whats ?app|wa\.me|crypto|forex|invest(ment)? (with|platform)|dm me|check my channel|sub ?4 ?sub)/.test(t)) return 'spam';
  // Timestamped summaries and chapter lists people paste are not conversation.
  if ((t.match(/\b\d{1,2}:\d{2}\b/g) ?? []).length >= 3) return 'other';
  if (/(please (make|do|cover|update|upload)|can (you|we) (make|do|cover|have|get)|could you (make|do|cover)|next video|make a video|do a video|part 2|\bversion please|update please|would love (a|to see)|you should (make|do|cover)|waiting for (the|a|part))/.test(t)) return 'request';
  const firstSentence = t.split(/(?<=[.!?])\s/)[0] ?? t;
  if (t.length <= 400 && (/\?\s*$/.test(t) || (/\?/.test(firstSentence) && /^(how|why|what|when|where|which|who|is|are|does|do|can|could|should|would|will|has|have|any)\b/.test(firstSentence)))) return 'question';
  if (/(wrong|incorrect|misleading|clickbait|disagree|not true|terrible|worst|boring|waste of|unsubscrib|disappoint|actually it'?s)/.test(t)) return 'criticism';
  if (/(thank|great|amazing|awesome|love|best|helpful|brilliant|gem|legend|masterpiece|excellent|incredible|so good|well explained)/.test(t)) return 'praise';
  return 'other';
}

export function triageComments(comments: VideoInfo['comments']): { piles: Record<Pile, VideoInfo['comments']>; pin?: VideoInfo['comments'][number]; why?: string } {
  const roots = comments.filter((c) => !c.parent || c.parent === 'root');
  const piles = { question: [], request: [], praise: [], criticism: [], spam: [], other: [] } as Record<Pile, VideoInfo['comments']>;
  for (const c of roots) piles[classifyComment(c.text)].push(c);
  for (const k of Object.keys(piles) as Pile[]) piles[k].sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  // Pin the most-liked real question (answering it in the pin helps everyone),
  // else the most-liked substantive praise.
  const q = piles.question.find((c) => c.text.length > 25);
  const p = piles.praise.find((c) => c.text.length > 60);
  const pin = q ?? p;
  return { piles, pin, why: pin ? (pin === q ? 'the most-liked real question: pin it with your answer' : 'the most-liked comment that says something specific') : undefined };
}

// ------------------------------------------------------------------ outliers + audit

export interface ChannelVideo {
  id: string;
  title: string;
  views: number;
  duration?: number;
}

export async function channelVideos(channelUrl: string, limit = 30): Promise<{ channel?: string; followers?: number; videos: ChannelVideo[] }> {
  const base = channelUrl.replace(/\/(videos|shorts|streams|featured)?\/?$/, '');
  const raw = JSON.parse(await ytDlp(['-J', '--flat-playlist', '--playlist-end', String(limit), `${base}/videos`], 120_000)) as Record<string, any>;
  return {
    channel: raw.channel ?? raw.uploader ?? raw.title,
    followers: raw.channel_follower_count ?? undefined,
    videos: (raw.entries ?? []).filter((e: any) => e.id && e.view_count !== undefined && e.view_count !== null).map((e: any) => ({ id: e.id, title: e.title, views: e.view_count, duration: e.duration ?? undefined })),
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Outlier {
  title: string;
  url: string;
  channel: string;
  views: number;
  channelMedian: number;
  multiple: number;
}

/**
 * What is working in a niche: search YouTube for the topic, then rank each
 * video by its views over its own channel's median, so a small channel's 5×
 * hit beats a big channel's ordinary upload.
 */
export async function outliers(scour: Scour, topic: string, opts: { channels?: number; min?: number } = {}): Promise<{ rows: Outlier[]; skipped: string[] }> {
  const found = await scour.search(topic, { source: 'youtube', limit: 30 });
  const byChannel = new Map<string, typeof found.results>();
  for (const r of found.results) {
    const ch = r.author?.name ?? '';
    if (ch) byChannel.set(ch, [...(byChannel.get(ch) ?? []), r]);
  }
  const rows: Outlier[] = [];
  const skipped: string[] = [];
  for (const [channel, results] of [...byChannel.entries()].slice(0, opts.channels ?? 8)) {
    try {
      const doc = await scour.get(results[0]!.url, { comments: false, transcript: false });
      const url = (doc.author?.url ?? '') as string;
      if (!url) throw new Error('no channel link');
      const { videos } = await channelVideos(url, 30);
      const med = median(videos.map((v) => v.views));
      for (const r of results) {
        const views = r.engagement?.views ?? videos.find((v) => r.url.includes(v.id))?.views ?? 0;
        if (!views || !med) continue;
        rows.push({ title: r.title, url: r.url, channel, views, channelMedian: med, multiple: Math.round((views / med) * 10) / 10 });
      }
    } catch (err) {
      skipped.push(`${channel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return { rows: rows.filter((r) => r.multiple >= (opts.min ?? 0)).sort((a, b) => b.multiple - a.multiple), skipped };
}

export interface Audit {
  channel?: string;
  followers?: number;
  videos: number;
  median: number;
  hits: (ChannelVideo & { multiple: number })[];
  misses: (ChannelVideo & { multiple: number })[];
  patterns: { trait: string; withIt: number; without: number; lift: number; n: number }[];
}

/** A channel's recent videos: hits and misses against its own median, and the title traits that go with them. */
export async function audit(channelUrl: string): Promise<Audit> {
  const { channel, followers, videos } = await channelVideos(channelUrl, 40);
  const med = median(videos.map((v) => v.views));
  const withMultiple = videos.map((v) => ({ ...v, multiple: med ? Math.round((v.views / med) * 10) / 10 : 0 }));
  const traits: [string, (v: ChannelVideo) => boolean][] = [
    ['a number in the title', (v) => /\d/.test(v.title)],
    ['a question', (v) => /\?/.test(v.title)],
    ['how/why/what', (v) => /\b(how|why|what)\b/i.test(v.title)],
    ['title under 50 characters', (v) => v.title.length < 50],
    ['words in CAPITALS', (v) => v.title.split(/\s+/).some((x) => x.length > 3 && x === x.toUpperCase() && /[A-Z]/.test(x))],
    ['longer than 20 minutes', (v) => (v.duration ?? 0) > 1200],
    ['under 10 minutes', (v) => (v.duration ?? 0) > 0 && (v.duration ?? 0) < 600],
  ];
  const patterns = traits
    .map(([trait, test]) => {
      const yes = videos.filter(test).map((v) => v.views);
      const no = videos.filter((v) => !test(v)).map((v) => v.views);
      const a = median(yes);
      const b = median(no);
      return { trait, withIt: Math.round(a), without: Math.round(b), lift: b ? Math.round((a / b) * 10) / 10 : 0, n: yes.length };
    })
    .filter((p) => p.n >= 3 && videos.length - p.n >= 3)
    .sort((x, y) => Math.abs(Math.log(y.lift || 1)) - Math.abs(Math.log(x.lift || 1)));
  return {
    channel, followers, videos: videos.length, median: med,
    hits: withMultiple.filter((v) => v.multiple >= 2).sort((a, b) => b.multiple - a.multiple).slice(0, 5),
    misses: withMultiple.filter((v) => v.multiple <= 0.5).sort((a, b) => a.multiple - b.multiple).slice(0, 5),
    patterns,
  };
}

// ------------------------------------------------------------------ keywords

/**
 * What people type into YouTube's search box about a topic: the topic's own
 * suggestions plus "topic a…z" and question forms. Real demand, free.
 */
export async function keywords(scour: Scour, topic: string, opts: { deep?: boolean } = {}): Promise<{ query: string; suggestions: string[] }[]> {
  const http = (scour as unknown as { http: { get(u: string, i?: unknown): Promise<{ body: string }> } }).http;
  const ask = async (q: string) => {
    const res = await http.get(`https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=en&q=${encodeURIComponent(q)}`, { timeoutMs: 10_000, retries: 1 });
    const m = /\(\s*(\[[\s\S]*\])\s*\)\s*$/.exec(res.body);
    if (!m) return [];
    const data = JSON.parse(m[1]!) as [string, [string, ...unknown[]][]];
    return (data[1] ?? []).map((x) => x[0]).filter((s) => s.toLowerCase() !== q.toLowerCase());
  };
  const queries = [topic, `how to ${topic}`, `${topic} vs`, `is ${topic}`, `why ${topic}`, ...(opts.deep ? 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `${topic} ${c}`) : [])];
  const out: { query: string; suggestions: string[] }[] = [];
  for (const q of queries) {
    const s = await ask(q).catch(() => []);
    if (s.length) out.push({ query: q, suggestions: s });
  }
  return out;
}

// ------------------------------------------------------------------ retention

export interface RetentionReport {
  points: number;
  hookLeak?: { at30s: number; message: string };
  cliffs: { at: number; drop: number; said?: string }[];
  slide?: string;
  endRetention?: number;
}

/**
 * A YouTube Studio audience-retention export (Analytics → Engagement → Audience
 * retention → export as CSV). Finds the hook leak, the steepest cliffs and the
 * long slide, and, with the video, what was being said at each cliff.
 */
export function analyzeRetention(csv: string, duration?: number, segments: Segment[] = []): RetentionReport {
  const lines = csv.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const head = lines[0]!.toLowerCase().split(',').map((h) => h.replace(/"/g, '').trim());
  const posCol = head.findIndex((h) => /position|time|elapsed/.test(h));
  const retCol = head.findIndex((h, i) => i !== posCol && /retention|audience|watching/.test(h) && !/relative/.test(h));
  if (posCol < 0 || retCol < 0) throw new Error('Could not find the position and retention columns; export "Audience retention" from YouTube Studio as CSV.');
  const pts = lines.slice(1).map((l) => l.split(',').map((x) => x.replace(/"/g, '').trim())).map((r) => ({ pos: Number(r[posCol]), ret: Number(r[retCol]) })).filter((p) => Number.isFinite(p.pos) && Number.isFinite(p.ret));
  if (pts.length < 5) throw new Error('Too few rows in the retention export');
  // Studio exports position either as a ratio (0–1), a percent (0–100) or seconds.
  const maxPos = Math.max(...pts.map((p) => p.pos));
  const toSec = (p: number) => (maxPos <= 1.01 && duration ? p * duration : maxPos <= 100.5 && duration ? (p / 100) * duration : p);
  const scale = Math.max(...pts.map((p) => p.ret)) > 1.5 ? 1 : 100;
  const series = pts.map((p) => ({ at: toSec(p.pos), ret: p.ret * scale }));
  const sayAt = (sec: number) => segments.find((s) => s.start <= sec && s.end >= sec - 3)?.text ?? segments.filter((s) => s.start <= sec).at(-1)?.text;
  const report: RetentionReport = { points: series.length, cliffs: [] };
  const start = series[0]!.ret;
  const at30 = series.find((p) => p.at >= 30) ?? series[Math.min(3, series.length - 1)]!;
  report.hookLeak = {
    at30s: Math.round(at30.ret),
    message: at30.ret >= 70 ? `the hook holds: ${Math.round(at30.ret)}% are still watching at 0:30` : `the hook leaks: only ${Math.round(at30.ret)}% are still watching at 0:30 (of ${Math.round(start)}% at the start)`,
  };
  // A cliff is timed where the viewers are already gone; what was said just before is why.
  const drops = series.slice(1).map((p, i) => ({ at: p.at, drop: series[i]!.ret - p.ret })).filter((d) => d.at > 30);
  report.cliffs = drops.sort((a, b) => b.drop - a.drop).filter((d) => d.drop >= 2).slice(0, 4).sort((a, b) => a.at - b.at).map((d) => ({ at: Math.round(d.at), drop: Math.round(d.drop * 10) / 10, said: segments.length ? sayAt(d.at) : undefined }));
  const mid = series.filter((p) => p.at > 30);
  if (mid.length > 4) {
    const slope = (mid.at(-1)!.ret - mid[0]!.ret) / Math.max(1, (mid.at(-1)!.at - mid[0]!.at) / 60);
    report.slide = `after the hook, ${Math.abs(slope).toFixed(1)}% of viewers leave per minute${slope < -3 ? ' (steep: tighten the middle)' : ''}`;
  }
  report.endRetention = Math.round(series.at(-1)!.ret);
  return report;
}
