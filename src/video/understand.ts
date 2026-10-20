import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configHome } from '../core/config.js';

const exec = promisify(execFile);

/**
 * Understanding any video the way a person watching it would: screen
 * recordings, app walkthroughs, demos, explainers.
 *
 * 1. Watch: sample the video twice a second, tiny and grey, and notice when
 *    the picture really changes (a new screen) versus small changes (typing,
 *    a cursor, a spinner). Ideas from PySceneDetect, tuned for UIs.
 * 2. Look: take one sharp frame per screen, after it has finished loading.
 * 3. Read: pull the text off each frame with the operating system's own OCR
 *    (Apple Vision on macOS; Tesseract elsewhere if installed).
 * 4. Understand: name each screen, notice when a screen comes back, and infer
 *    what was likely tapped to get from one screen to the next.
 * 5. Listen: if there is narration, transcribe it locally and attach what was
 *    said to the screen it was said on.
 *
 * Everything quoted comes from OCR or the transcript; inferences are labelled
 * as such (the loom-feedback lesson: video summaries must stay grounded).
 */

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface Screen {
  id: number;
  /** Same id as an earlier screen when this is a return visit. */
  sameAs?: number;
  start: number;
  end: number;
  title: string;
  lines: OcrLine[];
  /** Short texts that look like buttons, links or tabs. */
  controls: string[];
  /** Text that appeared while on this screen (typing, loading). */
  changes: string[];
  said: string;
  frame?: { mimeType: 'image/jpeg'; data: string };
  /** How we got here from the previous screen. */
  via?: { action: string; confidence: 'likely' | 'possible' };
}

export interface VideoUnderstanding {
  source: string;
  duration: number;
  width?: number;
  height?: number;
  screens: Screen[];
  ocr: string;
  narration: string;
  notes: string[];
}

// ------------------------------------------------------------------ media helpers

async function probe(file: string): Promise<{ duration: number; width?: number; height?: number; audio: boolean }> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeout: 30_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration ?? 0), width: v?.width, height: v?.height, audio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}

const SW = 64;
const SH = 36;

/** Tiny grey frames, `fps` per second: enough to see a screen change, cheap to compare. */
async function signatures(file: string, fps: number): Promise<Buffer[]> {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps},scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-'], {
    encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60_000,
  } as never);
  const buf = stdout as unknown as Buffer;
  const size = SW * SH;
  const out: Buffer[] = [];
  for (let i = 0; i + size <= buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

/** Mean absolute difference, ignoring tiny per-pixel noise (video compression). */
export function frameDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > 12) sum += d;
  }
  return sum / a.length;
}

/**
 * Split the video into stable stretches. A new screen starts when the picture
 * differs a lot from where the current screen settled; typing, cursors and
 * spinners change a small area and don't count. Very short stretches are
 * transitions (animations) and are dropped.
 */
export function segment(sigs: Buffer[], fps: number, opts: { threshold?: number; minSec?: number } = {}): { start: number; end: number; settle: number }[] {
  // Measured on recordings: a new screen scores 3–6, typing 0.1–0.5, a still screen 0.
  const threshold = opts.threshold ?? 1.5;
  const minSec = opts.minSec ?? 0.75;
  const segs: { start: number; end: number; settle: number }[] = [];
  if (!sigs.length) return segs;
  let startIdx = 0;
  let anchor = sigs[0]!;
  for (let i = 1; i <= sigs.length; i++) {
    const cur = sigs[i];
    const changed = !cur || frameDiff(anchor, cur) > threshold;
    if (cur && !changed) {
      // Drift slowly with the screen (content loading, typing) so a sequence
      // of small changes doesn't add up to a fake new screen.
      if (frameDiff(sigs[i - 1]!, cur) < 0.3) anchor = cur;
      continue;
    }
    const start = startIdx / fps;
    const end = i / fps;
    if (end - start >= minSec) segs.push({ start, end, settle: Math.max(start, end - 0.6) });
    startIdx = i;
    if (cur) anchor = cur;
  }
  return segs;
}

async function frameAt(file: string, at: number, dir: string, i: number): Promise<string> {
  const out = path.join(dir, `screen-${String(i).padStart(3, '0')}.jpg`);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', '-q:v', '3', '-y', out], { timeout: 60_000 });
  return out;
}

// ------------------------------------------------------------------ OCR

const SWIFT_OCR = `import Foundation
import Vision
import AppKit
var out: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(["file": path, "lines": []]); continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  let lines: [[String: Any]] = (req.results ?? []).compactMap { o in
    guard let c = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox
    return ["text": c.string, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "conf": c.confidence]
  }
  out.append(["file": path, "lines": lines])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`;

/**
 * Read the text on frames. macOS: Apple Vision through a tiny helper compiled
 * once into ~/.scour/bin (needs the Xcode command-line tools' swiftc; nothing
 * leaves the machine). Elsewhere: Tesseract if installed. Otherwise none.
 */
export async function ocrImages(files: string[]): Promise<{ engine: string; results: OcrLine[][] }> {
  if (!files.length) return { engine: 'none', results: [] };
  if (process.platform === 'darwin') {
    const bin = path.join(configHome(), 'bin', 'scour-ocr');
    const exists = await fs.stat(bin).then(() => true, () => false);
    if (!exists) {
      try {
        await fs.mkdir(path.dirname(bin), { recursive: true });
        const src = path.join(os.tmpdir(), `scour-ocr-${process.pid}.swift`);
        await fs.writeFile(src, SWIFT_OCR);
        await exec('swiftc', ['-O', src, '-o', bin], { timeout: 180_000 });
        await fs.rm(src, { force: true });
      } catch {
        // no compiler: fall through to Tesseract
      }
    }
    if (await fs.stat(bin).then(() => true, () => false)) {
      const { stdout } = await exec(bin, files, { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(stdout) as { file: string; lines: OcrLine[] }[];
      return { engine: 'Apple Vision', results: files.map((f) => parsed.find((p) => p.file === f)?.lines ?? []) };
    }
  }
  try {
    const results: OcrLine[][] = [];
    for (const f of files) {
      const { stdout } = await exec('tesseract', [f, '-', 'tsv'], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      results.push(tesseractLines(stdout));
    }
    return { engine: 'Tesseract', results };
  } catch {
    return { engine: 'none', results: files.map(() => []) };
  }
}

/** Tesseract TSV (word level) → lines with normalised boxes. */
function tesseractLines(tsv: string): OcrLine[] {
  const rows = tsv.trim().split('\n').slice(1).map((l) => l.split('\t'));
  const W = Math.max(1, ...rows.map((r) => Number(r[6]) + Number(r[8]) || 0));
  const H = Math.max(1, ...rows.map((r) => Number(r[7]) + Number(r[9]) || 0));
  const byLine = new Map<string, { words: string[]; x: number; y: number; r: number; b: number; conf: number[] }>();
  for (const r of rows) {
    if (r.length < 12 || !r[11]?.trim() || Number(r[10]) < 0) continue;
    const key = `${r[2]}-${r[3]}-${r[4]}`;
    const [x, y, w, h] = [Number(r[6]), Number(r[7]), Number(r[8]), Number(r[9])];
    const e = byLine.get(key) ?? { words: [], x, y, r: x + w, b: y + h, conf: [] };
    e.words.push(r[11]!);
    e.x = Math.min(e.x, x); e.y = Math.min(e.y, y); e.r = Math.max(e.r, x + w); e.b = Math.max(e.b, y + h);
    e.conf.push(Number(r[10]) / 100);
    byLine.set(key, e);
  }
  return [...byLine.values()].map((e) => ({ text: e.words.join(' '), x: e.x / W, y: e.y / H, w: (e.r - e.x) / W, h: (e.b - e.y) / H, conf: e.conf.reduce((a, b) => a + b, 0) / e.conf.length }));
}

// ------------------------------------------------------------------ understanding

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}$.,:/@ -]+/gu, '').replace(/\s+/g, ' ').trim();
/** Clock, battery and OS menu text: not part of the app. */
const CHROME = /^(\d{1,2}:\d{2}( ?[ap]m)?|\d{1,3}%|lte|5g|4g|wi-?fi|finder|file|edit|view|go|window|help)$/i;

function appLines(lines: OcrLine[]): OcrLine[] {
  const kept = lines.filter((l) => l.conf >= 0.3 && l.text.trim() && !CHROME.test(l.text.trim()));
  // Navigation and tab bars come back as one line ("Home Budgets Settings");
  // split them into their tabs. Only near the top or bottom edge, where bars live.
  return kept.flatMap((l) => {
    const words = l.text.trim().split(/\s+/);
    const bar = (l.y < 0.15 || l.y + l.h > 0.85) && words.length >= 2 && words.length <= 7 && words.every((w) => /^\p{Lu}[\p{L}&'-]{1,14}$/u.test(w));
    return bar ? words.map((w, i) => ({ ...l, text: w, x: l.x + (l.w * i) / words.length, w: l.w / words.length })) : [l];
  });
}

/** The screen's name: the biggest text near the top, skipping navigation-sized text. */
export function titleOf(lines: OcrLine[]): string {
  // Confident, real words, in the upper ~60% (phone layouts put headings mid-screen).
  const cands = appLines(lines).filter((l) => l.conf >= 0.6 && l.y < 0.6 && l.text.split(/\s+/).length <= 10 && (l.text.match(/\p{L}/gu) ?? []).length >= 4 && !CTA.test(l.text.trim()) && !/^(back|close|cancel|menu|more|skip|next|done)$/i.test(l.text.trim()));
  if (!cands.length) return '(untitled screen)';
  const best = cands.reduce((a, b) => (b.h > a.h * 1.15 || (Math.abs(b.h - a.h) <= a.h * 0.15 && b.y < a.y) ? b : a));
  return best.text.trim();
}

/** Short pieces of text that read like things you tap: buttons, links, tabs. */
export function controlsOf(lines: OcrLine[], title: string): string[] {
  return [...new Set(appLines(lines)
    .filter((l) => l.conf >= 0.6)
    .map((l) => l.text.trim())
    // Not typed-in values (emails, masked passwords) or labels with values ("Currency: USD").
    .filter((t) => t !== title && t.split(/\s+/).length <= 5 && t.length <= 40 && /\p{L}/u.test(t) && !/[.!?]$/.test(t) && !/:\s*\S/.test(t) && !/@|^[•.*]+$/.test(t)))];
}

export function textSimilarity(a: OcrLine[], b: OcrLine[]): number {
  const sa = new Set(appLines(a).map((l) => norm(l.text)).filter(Boolean));
  const sb = new Set(appLines(b).map((l) => norm(l.text)).filter(Boolean));
  if (!sa.size && !sb.size) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
}

const CTA = /^(get started|start|continue|next|sign ?up|sign ?in|log ?in|create account|save( changes)?|done|submit|confirm|ok(ay)?|allow|accept|agree|skip|finish|buy|pay|checkout|add|send|search|go)\b/i;

/**
 * What was probably tapped to get from one screen to the next: a control on
 * the previous screen named like the new screen's title, else a call to action
 * that vanished. Always labelled as an inference.
 */
export function inferAction(prev: Screen, next: Screen): Screen['via'] {
  const title = norm(next.title);
  const named = prev.controls.find((c) => {
    const n = norm(c);
    return n.length >= 3 && (title === n || title.includes(n) || n.includes(title));
  });
  if (named) return { action: `tapped "${named}"`, confidence: 'likely' };
  const nextText = new Set(next.lines.map((l) => norm(l.text)));
  const gone = prev.controls.filter((c) => !nextText.has(norm(c)));
  const cta = gone.find((c) => CTA.test(c.trim())) ?? prev.controls.find((c) => CTA.test(c.trim()));
  if (cta) return { action: `tapped "${cta}"`, confidence: gone.includes(cta) ? 'likely' : 'possible' };
  return undefined;
}

export async function understandVideo(
  source: string,
  opts: { images?: number; ocr?: boolean; narration?: boolean; fps?: number; lang?: string; onProgress?: (msg: string) => void } = {},
): Promise<VideoUnderstanding> {
  const say = opts.onProgress ?? (() => {});
  const notes: string[] = [];
  let file = source;
  let cleanup: (() => Promise<void>) | undefined;
  if (/^https?:\/\//i.test(source)) {
    say('downloading the video');
    const dl = await downloadVideo(source);
    file = dl.file;
    cleanup = dl.cleanup;
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-video-'));
  try {
    const info = await probe(file);
    const fps = opts.fps ?? (info.duration > 1800 ? 1 : 2);
    say(`watching ${Math.round(info.duration)} s of video`);
    const segs = segment(await signatures(file, fps), fps);
    if (!segs.length) notes.push('The picture never settled long enough to count as a screen.');

    say(`found ${segs.length} screens; taking a frame of each`);
    const framesFiles = await Promise.all(segs.map((s, i) => frameAt(file, s.settle, work, i)));
    let ocr = { engine: 'off', results: segs.map(() => [] as OcrLine[]) };
    if (opts.ocr !== false) {
      say('reading the text on each screen');
      // OCR reads a 2× enlargement: white-on-colour button labels ("Sign up")
      // come out garbled at screen size and clean at double size.
      const big = await Promise.all(framesFiles.map(async (f) => {
        const out = f.replace(/\.jpg$/, '-ocr.png');
        await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-vf', 'scale=iw*2:ih*2:flags=lanczos', '-y', out], { timeout: 60_000 });
        return out;
      }));
      ocr = await ocrImages(big);
      if (ocr.engine === 'none') notes.push('No OCR engine available (macOS uses Apple Vision automatically; elsewhere install tesseract), so screens are described by their frames only.');
    }

    // Build screens, folding consecutive stretches with the same text into one
    // screen (typing, loading and scrolling change the picture, not the screen).
    const screens: Screen[] = [];
    for (const [i, s] of segs.entries()) {
      const lines = ocr.results[i] ?? [];
      const prev = screens.at(-1);
      if (prev && lines.length && prev.lines.length && textSimilarity(prev.lines, lines) >= 0.5) {
        const before = new Set(prev.lines.map((l) => norm(l.text)));
        const added = appLines(lines).map((l) => l.text.trim()).filter((t) => !before.has(norm(t)));
        prev.changes.push(...added.map((t) => `${fmt(s.start)} "${t}" appeared`));
        prev.end = s.end;
        prev.lines = lines;
        prev.controls = controlsOf(lines, prev.title);
        prev.frame = { mimeType: 'image/jpeg', data: (await fs.readFile(framesFiles[i]!)).toString('base64') };
        continue;
      }
      const title = lines.length ? titleOf(lines) : `Screen ${screens.length + 1}`;
      const screen: Screen = {
        id: screens.length + 1, start: s.start, end: s.end, title, lines, controls: controlsOf(lines, title), changes: [], said: '',
        frame: { mimeType: 'image/jpeg', data: (await fs.readFile(framesFiles[i]!)).toString('base64') },
      };
      // A return visit: the same title and mostly the same text as an earlier screen.
      const earlier = screens.find((e) => !e.sameAs && norm(e.title) === norm(title) && textSimilarity(e.lines, lines) >= 0.4);
      if (earlier) screen.sameAs = earlier.id;
      if (prev) screen.via = inferAction(prev, screen);
      screens.push(screen);
    }

    // Narration, if any, attached to the screen it was said on.
    let narration = '';
    if (opts.narration !== false && info.audio) {
      say('listening to the narration');
      try {
        const { transcribeFile } = await import('../adapters/video.js');
        const t = await transcribeFile(file, { lang: opts.lang, allowEphemeral: true, prompt: screens.map((s) => s.title).join(', '), fine: true });
        narration = engineName(t.engine);
        for (const seg of t.segments) {
          const mid = (seg.start + seg.end) / 2;
          const sc = screens.find((s) => mid >= s.start && mid < s.end) ?? screens.filter((s) => s.start <= mid).at(-1);
          if (sc) sc.said = `${sc.said} ${seg.text}`.trim();
        }
      } catch (err) {
        notes.push(`Narration not transcribed: ${(err as Error).message.split('\n')[0]}`);
      }
    } else if (!info.audio) notes.push('The video has no audio track.');

    return { source, duration: info.duration, width: info.width, height: info.height, screens, ocr: ocr.engine, narration, notes };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await cleanup?.().catch(() => {});
  }
}

function engineName(e: string): string {
  return e;
}

/** Any video page yt-dlp understands (Loom, Vimeo, X, YouTube…) or a direct file link, at up to 720p. */
async function downloadVideo(url: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-dl-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    const { ytDlp } = await import('../adapters/video.js');
    await ytDlp(['-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b', '--merge-output-format', 'mp4', '-o', path.join(dir, 'video.%(ext)s'), url], 30 * 60_000);
    const name = (await fs.readdir(dir)).find((f) => f.startsWith('video.'));
    if (!name) throw new Error('nothing was downloaded');
    return { file: path.join(dir, name), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ report

/** The understanding as Markdown: flow, diagram, then each screen with what is on it and what was said. */
export function renderUnderstanding(v: VideoUnderstanding, maxImages: number): { markdown: string; images: { label: string; mimeType: string; data: string }[] } {
  const name = (s: Screen) => (s.sameAs ? v.screens.find((x) => x.id === s.sameAs)!.title : s.title);
  const nodeId = (s: Screen) => `S${s.sameAs ?? s.id}`;
  const flow = v.screens.map((s, i) => `${i ? `${s.via ? ` —(${s.via.action.replace(/^tapped /, '')})→ ` : ' → '}` : ''}${name(s)}`).join('');
  const unique = v.screens.filter((s) => !s.sameAs);
  const edges = v.screens.slice(1).map((s, i) => {
    const label = s.via ? `|${s.via.action.replace(/"/g, "'")}|` : '';
    return `  ${nodeId(v.screens[i]!)} -->${label} ${nodeId(s)}`;
  });
  const mermaid = ['```mermaid', 'flowchart LR', ...unique.map((s) => `  S${s.id}["${s.title.replace(/"/g, "'")}"]`), ...[...new Set(edges)], '```'].join('\n');

  // Which screens to show as images: every distinct screen first, evenly if too many.
  const pick = unique.length <= maxImages ? unique : Array.from({ length: maxImages }, (_, i) => unique[Math.floor((i * unique.length) / maxImages)]!);
  const images = pick.filter((s) => s.frame).map((s) => ({ label: `Screen ${s.id} "${s.title}" (${fmt(s.start)})`, mimeType: s.frame!.mimeType, data: s.frame!.data }));

  const sections = v.screens.map((s) => [
    `### ${s.id}. ${name(s)} · ${fmt(s.start)}–${fmt(s.end)}${s.sameAs ? ` (back to screen ${s.sameAs})` : ''}`,
    s.via ? `_How we got here: ${s.via.confidence} ${s.via.action}_` : '',
    s.controls.length ? `**Controls:** ${s.controls.slice(0, 12).map((c) => `\`${c}\``).join(' ')}` : '',
    appLines(s.lines).length ? `**On screen:** ${appLines(s.lines).filter((l) => l.text.trim() !== s.title).slice(0, 15).map((l) => l.text.trim()).join(' · ')}` : '',
    s.changes.length ? `**While here:** ${s.changes.slice(0, 8).join('; ')}` : '',
    s.said ? `**Said:** "${s.said}"` : '',
  ].filter(Boolean).join('\n\n'));

  const markdown = [
    `# Video walkthrough: ${path.basename(v.source.replace(/[?#].*$/, ''))}`,
    '',
    `_${fmt(v.duration)} long${v.width ? ` · ${v.width}×${v.height}` : ''} · ${v.screens.length} screens (${unique.length} distinct) · text read with ${v.ocr}${v.narration ? ` · narration transcribed with ${v.narration}` : ''}_`,
    '',
    `## Flow\n\n${flow || '(no screens found)'}`,
    '',
    unique.length > 1 ? mermaid : '',
    '',
    '## Screens',
    '',
    sections.join('\n\n'),
    ...(v.notes.length ? ['', '## Notes', '', ...v.notes.map((n) => `- ${n}`)] : []),
    '',
    `_Screen names come from the largest text on each screen; "how we got here" is inferred from the controls, not seen. ${images.length} key frames are attached so you can check what each screen shows. Ask for the onboarding steps, the feature list, or a test plan, and work only from what is above._`,
  ].join('\n');
  return { markdown: markdown.replace(/\n{3,}/g, '\n\n'), images };
}
