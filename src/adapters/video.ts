import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HttpClient } from '../core/types.js';

const exec = promisify(execFile);

/**
 * Understanding videos, free and local. What the best open-source tools do,
 * in one place:
 *
 * - timestamped transcripts grouped by the video's chapters, in any caption
 *   language or YouTube's own auto-translation (youtube-transcript-api,
 *   youtube-digest)
 * - "most replayed" moments from YouTube's heatmap, likes and top comments
 * - sponsor segments cut out using SponsorBlock's community data
 * - key frames, so a model can see the slides, code and charts on screen,
 *   grabbed with ffmpeg straight from the stream at chosen moments (no
 *   download), near-duplicates dropped (video-understanding-skill)
 * - local Whisper transcription when a video has no captions, and for audio
 *   or video files on disk (faster-whisper, whisper.cpp, MLX Whisper)
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

// ------------------------------------------------------------------ yt-dlp

let ytDlpResolved: string[] | null | undefined;

/** How to run yt-dlp: installed, else an ephemeral pipx/uv run (nothing installed). */
export async function ytDlpCommand(): Promise<string[] | null> {
  if (ytDlpResolved !== undefined) return ytDlpResolved;
  for (const cmd of [['yt-dlp'], ['pipx', 'run', 'yt-dlp'], ['uvx', 'yt-dlp']]) {
    try {
      await exec(cmd[0]!, [...cmd.slice(1), '--version'], { timeout: 90_000 });
      ytDlpResolved = cmd;
      return cmd;
    } catch {
      // try the next way
    }
  }
  ytDlpResolved = null;
  return null;
}

export class RateLimited extends Error {}

export async function ytDlp(args: string[], timeoutMs: number): Promise<string> {
  const cmd = await ytDlpCommand();
  if (!cmd) throw new Error('yt-dlp is not available (brew install yt-dlp, or have pipx or uv on PATH)');
  try {
    const { stdout } = await exec(cmd[0]!, [...cmd.slice(1), '--no-warnings', ...args], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const out = `${e.stderr ?? ''} ${e.message}`;
    if (/429|Too Many Requests|confirm you.re not a bot/i.test(out)) {
      throw new RateLimited('YouTube is temporarily rate-limiting this connection (HTTP 429 / bot check).');
    }
    throw new Error(out.split('\n').find((l) => /ERROR/.test(l))?.trim() ?? e.message.split('\n')[0]!);
  }
}

export interface VideoInfo {
  id: string;
  title?: string;
  channel?: string;
  channelUrl?: string;
  followers?: number;
  duration?: number;
  views?: number;
  likes?: number;
  commentCount?: number;
  uploadDate?: string;
  language?: string;
  description?: string;
  chapters: Chapter[];
  heatmap: { start: number; end: number; value: number }[];
  subtitles: Record<string, { ext: string; url: string; name?: string }[]>;
  autoCaptions: Record<string, { ext: string; url: string; name?: string }[]>;
  comments: { author?: string; text: string; likes?: number; parent?: string; id?: string; timestamp?: number }[];
  formats: { url: string; height?: number; ext?: string; vcodec?: string; acodec?: string; protocol?: string }[];
}

/** Everything about a video in one yt-dlp call, optionally with its top comments. */
export async function videoInfo(url: string, opts: { comments?: number; timeoutMs: number }): Promise<VideoInfo> {
  const args = ['-J', '--skip-download'];
  if (opts.comments) {
    args.push('--write-comments', '--extractor-args', `youtube:max_comments=${opts.comments},all,0,0;comment_sort=top`);
  }
  const raw = JSON.parse(await ytDlp([...args, url], Math.max(opts.timeoutMs, 60_000))) as Record<string, any>;
  const date = typeof raw.upload_date === 'string' && /^\d{8}$/.test(raw.upload_date)
    ? `${raw.upload_date.slice(0, 4)}-${raw.upload_date.slice(4, 6)}-${raw.upload_date.slice(6, 8)}`
    : undefined;
  return {
    id: raw.id,
    title: raw.title,
    channel: raw.channel ?? raw.uploader,
    channelUrl: raw.channel_url ?? raw.uploader_url,
    followers: raw.channel_follower_count ?? undefined,
    duration: raw.duration ?? undefined,
    views: raw.view_count ?? undefined,
    likes: raw.like_count ?? undefined,
    // With --write-comments yt-dlp reports how many it fetched, not the video's total.
    commentCount: opts.comments ? undefined : raw.comment_count ?? undefined,
    uploadDate: date,
    language: raw.language ?? undefined,
    description: raw.description ?? undefined,
    chapters: (raw.chapters ?? []).map((c: any) => ({ start: c.start_time, end: c.end_time, title: c.title })),
    heatmap: (raw.heatmap ?? []).map((h: any) => ({ start: h.start_time, end: h.end_time, value: h.value })),
    subtitles: raw.subtitles ?? {},
    autoCaptions: raw.automatic_captions ?? {},
    comments: (raw.comments ?? []).map((c: any) => ({ id: c.id, author: c.author, text: c.text ?? '', likes: c.like_count ?? 0, parent: c.parent, timestamp: c.timestamp })),
    formats: (raw.formats ?? []).filter((f: any) => f.url).map((f: any) => ({ url: f.url, height: f.height ?? undefined, ext: f.ext, vcodec: f.vcodec, acodec: f.acodec, protocol: f.protocol })),
  };
}

// ------------------------------------------------------------------ captions

/**
 * Which caption track to read. `lang` asks for a language: a human track in
 * it, else YouTube's auto-generated one, else YouTube's auto-translation into
 * it. Without `lang`: a human track in the video's language, then the
 * auto-generated original, then English.
 */
export function pickCaptions(info: VideoInfo, lang?: string): { url: string; lang: string; kind: 'human' | 'auto' | 'translated' } | null {
  const json3 = (tracks?: { ext: string; url: string }[]) => tracks?.find((t) => t.ext === 'json3')?.url;
  const keys = (o: Record<string, unknown>, l: string) => Object.keys(o).filter((k) => k === l || k.startsWith(`${l}-`));
  const orig = info.language?.split('-')[0];
  // Auto-dubbed videos carry an "-orig" track per dub language; the real one matches the video's language.
  const origKeys = Object.keys(info.autoCaptions).filter((k) => k.endsWith('-orig'));
  const autoOrig = origKeys.find((k) => k === `${orig}-orig`) ?? (origKeys.length === 1 ? origKeys[0] : origKeys.find((k) => k === 'en-orig') ?? origKeys[0]);
  if (lang) {
    for (const k of keys(info.subtitles, lang)) { const u = json3(info.subtitles[k]); if (u) return { url: u, lang: k, kind: 'human' }; }
    const native = origKeys.includes(`${lang}-orig`) ? `${lang}-orig` : autoOrig?.startsWith(`${lang}-`) ? autoOrig : orig === lang ? lang : undefined;
    if (native && json3(info.autoCaptions[native])) return { url: json3(info.autoCaptions[native])!, lang, kind: 'auto' };
    const tr = json3(info.autoCaptions[lang]);
    if (tr) return { url: tr, lang, kind: orig === lang ? 'auto' : 'translated' };
    return null;
  }
  for (const l of [orig, 'en'].filter(Boolean) as string[]) {
    for (const k of keys(info.subtitles, l)) { const u = json3(info.subtitles[k]); if (u) return { url: u, lang: k, kind: 'human' }; }
  }
  const first = Object.keys(info.subtitles).find((k) => k !== 'live_chat' && json3(info.subtitles[k]));
  if (first) return { url: json3(info.subtitles[first])!, lang: first, kind: 'human' };
  if (autoOrig && json3(info.autoCaptions[autoOrig])) return { url: json3(info.autoCaptions[autoOrig])!, lang: autoOrig.replace(/-orig$/, ''), kind: 'auto' };
  if (orig && json3(info.autoCaptions[orig])) return { url: json3(info.autoCaptions[orig])!, lang: orig, kind: 'auto' };
  if (json3(info.autoCaptions.en)) return { url: json3(info.autoCaptions.en)!, lang: 'en', kind: orig && orig !== 'en' ? 'translated' : 'auto' };
  return null;
}

/** YouTube's json3 captions → timed segments, rolling duplicates merged. */
export function parseJson3(body: string): Segment[] {
  const json = JSON.parse(body) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
  const out: Segment[] = [];
  for (const e of json.events ?? []) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (e.tStartMs ?? 0) / 1000;
    out.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

/** WebVTT (from Whisper or yt-dlp) → timed segments. */
export function parseVtt(vtt: string): Segment[] {
  const out: Segment[] = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i]!.split('-->').map((t) => clock(t.trim().split(' ')[0]!));
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (out.length && out.at(-1)!.text === text) continue;
    out.push({ start: a!, end: z!, text });
  }
  return out;
}

function clock(t: string): number {
  const parts = t.replace(',', '.').split(':').map(Number);
  return parts.reduce((s, p) => s * 60 + p, 0);
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Transcript as Markdown: a section per chapter, paragraphs of about 45
 * seconds, each starting with a timestamp that links to that moment.
 */
export function renderTranscript(segments: Segment[], chapters: Chapter[], link?: (sec: number) => string): string {
  const stamp = (sec: number) => (link ? `[${fmtTime(sec)}](${link(sec)})` : `[${fmtTime(sec)}]`);
  const sections = chapters.length ? chapters : [{ start: 0, end: Infinity, title: '' }];
  const out: string[] = [];
  for (const ch of sections) {
    const inside = segments.filter((s) => s.start >= ch.start && s.start < (ch.end || Infinity));
    if (!inside.length) continue;
    if (ch.title) out.push(`### ${fmtTime(ch.start)} ${ch.title}`);
    let para: Segment[] = [];
    const flush = () => {
      if (!para.length) return;
      out.push(`${stamp(para[0]!.start)} ${para.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()}`);
      para = [];
    };
    for (const s of inside) {
      para.push(s);
      const span = s.end - para[0]!.start;
      if (span >= 45 && /[.!?]["')\]]?$/.test(s.text)) flush();
      else if (span >= 75) flush();
    }
    flush();
  }
  return out.join('\n\n');
}

/** The few moments people replay most, from YouTube's heatmap (peaks, not neighbours). */
export function mostReplayed(heatmap: VideoInfo['heatmap'], n = 3): { start: number; end: number; value: number }[] {
  const sorted = heatmap.slice(1).filter((h) => h.value > 0).sort((a, b) => b.value - a.value); // the first bucket is the intro everyone sees
  const picked: typeof sorted = [];
  for (const h of sorted) {
    if (picked.some((p) => Math.abs(p.start - h.start) < (h.end - h.start) * 4)) continue;
    picked.push(h);
    if (picked.length >= n) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ SponsorBlock

export interface SkipSegment {
  start: number;
  end: number;
  category: string;
}

/** Community-marked sponsor, self-promotion and "like & subscribe" segments (sponsor.ajay.app, free). */
export async function sponsorSegments(videoId: string, http: HttpClient): Promise<SkipSegment[]> {
  const cats = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo', 'interaction']));
  const res = await http.get(`https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${cats}`, { timeoutMs: 8000, retries: 0, allowStatus: [404] });
  if (res.status === 404) return [];
  return (JSON.parse(res.body) as { segment: [number, number]; category: string }[]).map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
}

export function withoutSegments(segments: Segment[], skip: SkipSegment[]): Segment[] {
  if (!skip.length) return segments;
  return segments.filter((s) => !skip.some((k) => s.start >= k.start - 0.5 && s.end <= k.end + 0.5));
}

// ------------------------------------------------------------------ frames

export interface Frame {
  at: number;
  label: string;
  mimeType: 'image/jpeg';
  data: string;
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await exec('ffmpeg', ['-version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * When to look: the start of each chapter (a little in, past the title card),
 * the most replayed moments, then evenly through the rest.
 */
export function frameTimes(duration: number, chapters: Chapter[], peaks: { start: number; end: number }[], n: number): { at: number; label: string }[] {
  const want: { at: number; label: string }[] = [];
  const add = (at: number, label: string) => {
    if (at < 0 || (duration && at > duration - 1)) return;
    if (want.some((w) => Math.abs(w.at - at) < Math.max(8, duration / (n * 4)))) return;
    want.push({ at, label });
  };
  for (const p of peaks) add((p.start + p.end) / 2, 'most replayed');
  for (const c of chapters) add(c.start + Math.min(15, (c.end - c.start) / 3), c.title);
  for (let i = 1; want.length < n * 2 && i <= n * 2; i++) add((duration * i) / (n * 2 + 1), '');
  // Keep the most informative mix, then put them in time order.
  return want.slice(0, Math.max(n * 2, n)).sort((a, b) => a.at - b.at);
}

/**
 * Grab frames from a video URL or file at the given moments, scaled to 768px
 * wide, dropping near-duplicates (the same slide twice), keeping at most `n`.
 */
export async function grabFrames(source: string, times: { at: number; label: string }[], n: number): Promise<Frame[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-frames-'));
  try {
    const shots = await pooled(
      times,
      4,
      async (t, i) => {
        const file = path.join(dir, `f${i}.jpg`);
        try {
          await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t.at), '-i', source, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', '-y', file], { timeout: 45_000 });
          const sig = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', timeout: 10_000, maxBuffer: 1 << 20 } as never);
          return { ...t, file, sig: (sig as unknown as { stdout: Buffer }).stdout };
        } catch {
          return null;
        }
      },
    );
    const kept: { at: number; label: string; file: string; sig: Buffer }[] = [];
    for (const s of shots) {
      if (!s || !s.sig.length) continue;
      const dup = kept.some((k) => meanDiff(k.sig, s.sig) < 6);
      if (!dup) kept.push(s);
    }
    // Too many: keep labelled moments first, then spread the rest evenly.
    let chosen = kept;
    if (kept.length > n) {
      const labelled = kept.filter((k) => k.label);
      const rest = kept.filter((k) => !k.label);
      chosen = labelled.length >= n ? spread(labelled, n) : [...labelled, ...spread(rest, n - labelled.length)];
      chosen.sort((a, b) => a.at - b.at);
    }
    return Promise.all(chosen.map(async (k) => ({ at: k.at, label: k.label, mimeType: 'image/jpeg' as const, data: (await fs.readFile(k.file)).toString('base64') })));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** k items spread evenly through the list. */
function spread<T>(arr: T[], k: number): T[] {
  if (k >= arr.length) return arr;
  return Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]!);
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

function meanDiff(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += Math.abs(a[i]! - b[i]!);
  return len ? sum / len : 255;
}

/** A video stream ffmpeg can seek in over HTTP: up to 480p, H.264 preferred. */
export function seekableStream(info: VideoInfo): string | undefined {
  const video = info.formats.filter((f) => f.vcodec && f.vcodec !== 'none' && (f.height ?? 0) >= 240 && (f.height ?? 0) <= 480 && /^https?/.test(f.protocol ?? 'https'));
  const pick = video.find((f) => /^avc1/.test(f.vcodec ?? '') && f.ext === 'mp4') ?? video.find((f) => f.ext === 'mp4') ?? video[0];
  return pick?.url;
}

// ------------------------------------------------------------------ Whisper

let whisperResolved: { cmd: string[]; kind: string } | null | undefined;

/**
 * A local Whisper, best first: whatever SCOUR_WHISPER names, then MLX Whisper
 * (Apple Silicon), faster-whisper's CLI, OpenAI's whisper, whisper.cpp. With
 * `allowEphemeral`, run MLX Whisper / faster-whisper through pipx or uv
 * (nothing installed; the model downloads once, ~150 MB for "base").
 */
export async function whisperCommand(allowEphemeral = false): Promise<{ cmd: string[]; kind: string } | null> {
  if (whisperResolved) return whisperResolved;
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const candidates: { cmd: string[]; kind: string }[] = [
    ...(process.env.SCOUR_WHISPER ? [{ cmd: process.env.SCOUR_WHISPER.split(' '), kind: guessKind(process.env.SCOUR_WHISPER) }] : []),
    { cmd: ['mlx_whisper'], kind: 'mlx' },
    { cmd: ['whisper-ctranslate2'], kind: 'ct2' },
    { cmd: ['whisper'], kind: 'openai' },
    ...(process.env.WHISPER_CPP_MODEL ? [{ cmd: ['whisper-cli'], kind: 'cpp' }] : []),
    ...(allowEphemeral
      ? [
          ...(appleSilicon ? [{ cmd: ['pipx', 'run', '--spec', 'mlx-whisper', 'mlx_whisper'], kind: 'mlx' }, { cmd: ['uvx', '--from', 'mlx-whisper', 'mlx_whisper'], kind: 'mlx' }] : []),
          { cmd: ['pipx', 'run', 'whisper-ctranslate2'], kind: 'ct2' },
          { cmd: ['uvx', 'whisper-ctranslate2'], kind: 'ct2' },
        ]
      : []),
  ];
  for (const c of candidates) {
    try {
      await exec(c.cmd[0]!, [...c.cmd.slice(1), '--help'], { timeout: 300_000 });
      if (!c.cmd.includes('run') && !c.cmd[0]!.startsWith('uvx')) whisperResolved = c;
      return c;
    } catch {
      // next
    }
  }
  if (!allowEphemeral) whisperResolved = null;
  return null;
}

function guessKind(cmd: string): string {
  return /mlx/.test(cmd) ? 'mlx' : /ctranslate2/.test(cmd) ? 'ct2' : /whisper-cli|main$/.test(cmd) ? 'cpp' : 'openai';
}

/** Transcribe an audio or video file locally into timed segments. */
export async function transcribeFile(
  file: string,
  opts: { lang?: string; allowEphemeral?: boolean; timeoutMs?: number; prompt?: string } = {},
): Promise<{ segments: Segment[]; engine: string }> {
  const w = await whisperCommand(opts.allowEphemeral);
  if (!w) {
    throw new Error(
      'No local Whisper found. Install one (free, runs on this Mac): `pipx install mlx-whisper` on Apple Silicon, ' +
        'or `pipx install whisper-ctranslate2`; or pass --transcribe to run one without installing.',
    );
  }
  // Model: large-v3-turbo on Apple Silicon (as fast as "small" there, far more
  // accurate), "small" elsewhere; SCOUR_WHISPER_MODEL overrides.
  const size = process.env.SCOUR_WHISPER_MODEL ?? (w.kind === 'mlx' ? 'large-v3-turbo' : 'small');
  const mlxModel = size === 'large-v3-turbo' || size === 'turbo' ? 'mlx-community/whisper-large-v3-turbo' : `mlx-community/whisper-${size}-mlx`;
  // Names and jargon from the title and chapters steer Whisper to the right
  // spellings ("an AI", not "and are you").
  const prompt = opts.prompt?.replace(/\s+/g, ' ').trim().slice(0, 400);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-whisper-'));
  try {
    const args =
      w.kind === 'mlx' ? [file, '--model', mlxModel, '-f', 'vtt', '-o', out, ...(opts.lang ? ['--language', opts.lang] : []), ...(prompt ? ['--initial-prompt', prompt] : [])]
      : w.kind === 'ct2' ? [file, '--model', size, '--output_format', 'vtt', '--output_dir', out, ...(opts.lang ? ['--language', opts.lang] : []), ...(prompt ? ['--initial_prompt', prompt] : [])]
      : w.kind === 'cpp' ? ['-m', process.env.WHISPER_CPP_MODEL!, '-f', await toWav(file, out), '-ovtt', '-of', path.join(out, 'out'), ...(opts.lang ? ['-l', opts.lang] : []), ...(prompt ? ['--prompt', prompt] : [])]
      : [file, '--model', size, '--output_format', 'vtt', '--output_dir', out, ...(opts.lang ? ['--language', opts.lang] : []), ...(prompt ? ['--initial_prompt', prompt] : [])];
    await exec(w.cmd[0]!, [...w.cmd.slice(1), ...args], { timeout: opts.timeoutMs ?? 60 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const vtt = (await fs.readdir(out)).find((f) => f.endsWith('.vtt'));
    if (!vtt) throw new Error('Whisper finished without writing a transcript');
    return { segments: parseVtt(await fs.readFile(path.join(out, vtt), 'utf-8')), engine: `${w.kind === 'mlx' ? 'MLX Whisper' : w.kind === 'ct2' ? 'faster-whisper' : w.kind === 'cpp' ? 'whisper.cpp' : 'Whisper'} (${size})` };
  } finally {
    await fs.rm(out, { recursive: true, force: true }).catch(() => {});
  }
}

/** whisper.cpp wants 16 kHz mono WAV. */
async function toWav(file: string, dir: string): Promise<string> {
  const wav = path.join(dir, 'audio.wav');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-y', wav], { timeout: 30 * 60_000 });
  return wav;
}

/** Download only the audio of a video (small: about 1 MB a minute). */
export async function downloadAudio(url: string, timeoutMs: number): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-audio-'));
  await ytDlp(['-f', 'bestaudio[ext=m4a]/bestaudio', '-o', path.join(dir, 'audio.%(ext)s'), url], Math.max(timeoutMs, 10 * 60_000));
  const name = (await fs.readdir(dir)).find((f) => f.startsWith('audio.'));
  if (!name) throw new Error('yt-dlp did not save the audio');
  return { file: path.join(dir, name), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export const MEDIA_FILES = /\.(mp3|m4a|wav|flac|ogg|opus|aac|mp4|m4v|mov|mkv|webm|avi)$/i;
export const VIDEO_FILES = /\.(mp4|m4v|mov|mkv|webm|avi)$/i;

/** Length of a local media file, in seconds. */
export async function mediaDuration(file: string): Promise<number | undefined> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 20_000 });
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ translation

/**
 * Translate lines on this machine with Argos Translate (open source, offline;
 * each language pair is a ~100 MB download, once). One line in, one line out,
 * so timestamps stay aligned. Used when YouTube's own translation refuses.
 */
export async function translateLines(lines: string[], from: string, to: string, timeoutMs = 20 * 60_000): Promise<string[]> {
  const run = async (tool: 'argos-translate' | 'argospm', args: string[], input?: string) => {
    for (const cmd of [[tool], ['pipx', 'run', '--spec', 'argostranslate', tool], ['uvx', '--from', 'argostranslate', tool]]) {
      try {
        const child = execFile(cmd[0]!, [...cmd.slice(1), ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
        const done = new Promise<string>((resolve, reject) => {
          let out = '';
          child.stdout?.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${tool} exited ${code}`))));
        });
        if (input !== undefined) child.stdin?.end(input);
        return await done;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    throw new Error('Argos Translate is not available (pipx or uv is needed to run it)');
  };
  // Language packages: English is the hub, so X→Y needs X→en and en→Y.
  const pairs = from === 'en' || to === 'en' ? [[from, to]] : [[from, 'en'], ['en', to]];
  for (const [a, b] of pairs) {
    try {
      await run('argospm', ['install', `translate-${a}_${b}`]);
    } catch {
      await run('argospm', ['update']);
      await run('argospm', ['install', `translate-${a}_${b}`]).catch(() => {
        throw new Error(`Argos Translate has no ${a}→${b} model`);
      });
    }
  }
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim() || '.');
  const out = (await run('argos-translate', ['--from-lang', from, '--to-lang', to], `${clean.join('\n')}\n`)).replace(/\s+$/, '').split('\n');
  if (out.length === lines.length) return out;
  // A stray blank line or two: drop empty lines and try again to line up.
  const dense = out.filter((l) => l.trim());
  if (dense.length === lines.length) return dense;
  throw new Error(`translation returned ${out.length} lines for ${lines.length}`);
}
