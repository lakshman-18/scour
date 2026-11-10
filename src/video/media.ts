import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configHome } from '../core/config.js';
import type { OcrLine } from './ui.js';

const exec = promisify(execFile);

/** Media plumbing for the video watcher: probing, frames, OCR, downloads. All local. */

export async function probe(file: string): Promise<{ duration: number; width?: number; height?: number; audio: boolean }> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeout: 30_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration ?? 0), width: v?.width, height: v?.height, audio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}


/** A frame at a time, as an image file (scaled to at most `maxW` wide). */
export async function frameFile(file: string, at: number, out: string, opts: { maxW?: number; scale?: number; filter?: string } = {}): Promise<string> {
  const vf = [opts.scale ? `scale=iw*${opts.scale}:ih*${opts.scale}:flags=lanczos` : `scale=min(${opts.maxW ?? 1280}\\,iw):-2`, opts.filter].filter(Boolean).join(',');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, at).toFixed(3), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '3', '-y', out], { timeout: 60_000 });
  return out;
}

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


/** Run ffmpeg with arguments, for the report's images. */
export async function ffmpeg(args: string[]): Promise<void> {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 120_000 });
}

/** Any video page yt-dlp understands (Loom, Vimeo, X, YouTube…) or a direct file link, at up to 720p. */
export async function downloadVideo(url: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
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


export const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSec = (sec: number): string => (sec < 10 ? `${sec.toFixed(1)} s` : `${Math.round(sec)} s`);

export { fs, os, path };
