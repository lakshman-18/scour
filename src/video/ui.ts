import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Box } from './signal.js';

const exec = promisify(execFile);

/**
 * Reading a screen the way a person does: not just its words, but what each
 * word *is*. A label on a filled rounded rectangle is a button; grey text in
 * a bordered box is an empty input; red text near a form is an error; the
 * biggest text near the top is the screen's title. Decided from the pixels
 * around each piece of text, so it works on any app, any platform.
 */
export interface OcrLine {
  text: string;
  /** Normalised 0–1 box. */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export type ElementKind = 'title' | 'button' | 'input' | 'link' | 'tab' | 'text' | 'error' | 'value';

export interface UiElement {
  kind: ElementKind;
  text: string;
  /** Box in video pixels (the container for buttons and inputs, the text otherwise). */
  box: Box;
  /** For inputs: the text is a placeholder (nothing typed yet). */
  placeholder?: boolean;
  conf: number;
  /** The text's own box (for buttons and inputs, `box` is the container). */
  textBox: Box;
}

export interface Rgb {
  w: number;
  h: number;
  data: Buffer;
}

/** One full-size frame as raw RGB, for looking at colours. */
export async function rgbFrame(file: string, at: number, w: number, h: number): Promise<Rgb> {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000,
  } as never);
  return { w, h, data: stdout as unknown as Buffer };
}

type Px = [number, number, number];
const px = (img: Rgb, x: number, y: number): Px => {
  const cx = Math.min(img.w - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(img.h - 1, Math.max(0, Math.round(y)));
  const i = (cy * img.w + cx) * 3;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};
const cdist = (a: Px, b: Px) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (c: Px) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** The most common colour in a set of samples (bucketed), i.e. a background. */
function modeColour(samples: Px[]): Px {
  const counts = new Map<string, { n: number; c: Px }>();
  for (const s of samples) {
    const k = s.map((v) => v >> 4).join(',');
    const e = counts.get(k) ?? { n: 0, c: s };
    e.n++;
    counts.set(k, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c ?? [255, 255, 255];
}

/** The page background: the commonest colour on a coarse grid over the frame. */
export function pageBackground(img: Rgb): Px {
  const s: Px[] = [];
  for (let y = 0; y < img.h; y += Math.max(4, Math.floor(img.h / 60))) for (let x = 0; x < img.w; x += Math.max(4, Math.floor(img.w / 80))) s.push(px(img, x, y));
  return modeColour(s);
}

/** The colour just around a piece of text (its surface), and the text's own ink colour. */
function surfaceAndInk(img: Rgb, b: Box): { surface: Px; ink: Px } {
  const ring: Px[] = [];
  const pad = Math.max(3, b.h * 0.25);
  for (let x = b.x - pad; x <= b.x + b.w + pad; x += Math.max(2, b.w / 40)) { ring.push(px(img, x, b.y - pad)); ring.push(px(img, x, b.y + b.h + pad)); }
  for (let y = b.y; y <= b.y + b.h; y += Math.max(2, b.h / 6)) { ring.push(px(img, b.x - pad, y)); ring.push(px(img, b.x + b.w + pad, y)); }
  const surface = modeColour(ring);
  // Ink: the pixels inside the text box that differ most from the surface.
  const inside: Px[] = [];
  for (let y = b.y + b.h * 0.2; y < b.y + b.h * 0.8; y += Math.max(1, b.h / 10)) for (let x = b.x; x < b.x + b.w; x += Math.max(1, b.w / 60)) inside.push(px(img, x, y));
  inside.sort((p, q) => cdist(q, surface) - cdist(p, surface));
  const top = inside.slice(0, Math.max(1, Math.floor(inside.length * 0.15)));
  const ink: Px = [0, 1, 2].map((i) => Math.round(top.reduce((s, p) => s + p[i]!, 0) / top.length)) as Px;
  return { surface, ink };
}

/**
 * The container around a piece of text: walk outwards from the text over its
 * surface colour until the colour changes (an edge). Returns the box and
 * whether that edge was a thin border (outlined) or the end of a fill.
 */
function container(img: Rgb, b: Box, surface: Px, page: Px): { box: Box; outlined: boolean } {
  const cy = b.y + b.h / 2;
  const cx = b.x + b.w / 2;
  const walk = (dx: number, dy: number, limit: number) => {
    let x = dx ? (dx > 0 ? b.x + b.w : b.x) : cx;
    let y = dy ? (dy > 0 ? b.y + b.h : b.y) : cy;
    for (let i = 0; i < limit; i += 2) {
      x += dx * 2; y += dy * 2;
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) break;
      if (cdist(px(img, x, y), surface) > 38) return { dist: i + 2, edge: px(img, x, y), x, y };
    }
    return { dist: limit, edge: surface, x, y };
  };
  const l = walk(-1, 0, img.w * 0.6), r = walk(1, 0, img.w * 0.6), u = walk(0, -1, b.h * 3), d = walk(0, 1, b.h * 3);
  const box = { x: l.x, y: u.y, w: r.x - l.x, h: d.y - u.y };
  // Outlined: the surface is the page colour and the edge is a line, not a new fill.
  const beyond = px(img, r.x + 6, cy);
  const outlined = cdist(surface, page) < 20 && cdist(beyond, page) < 30 && r.dist < img.w * 0.55;
  return { box, outlined };
}

const ERROR_WORDS = /\b(error|invalid|incorrect|required|must|failed|failure|wrong|not (be )?(found|allowed|valid)|try again|too (short|long)|already (taken|exists|in use)|unable|denied)\b/i;
const CHROME = /^(\d{1,2}:\d{2}( ?[ap]m)?|\d{1,3}%|lte|5g|4g|wi-?fi)$/i;

/** Every piece of text on a screen, classified. */
export function classify(lines: OcrLine[], img: Rgb | undefined, videoW: number, videoH: number): UiElement[] {
  const page = img ? pageBackground(img) : ([255, 255, 255] as Px);
  const usable = lines.filter((l) => l.conf >= 0.3 && l.text.trim() && !CHROME.test(l.text.trim()));
  const heights = usable.map((l) => l.h).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0.03;
  const out: UiElement[] = [];
  for (const l of splitBars(usable)) {
    const text = l.text.trim();
    const box = { x: l.x * videoW, y: l.y * videoH, w: l.w * videoW, h: l.h * videoH };
    const words = text.split(/\s+/).length;
    let kind: ElementKind = 'text';
    let finalBox = box;
    let placeholder: boolean | undefined;
    if (img) {
      const { surface, ink } = surfaceAndInk(img, box);
      const filled = cdist(surface, page) > 28;
      const reddish = ink[0] > 150 && ink[0] > ink[1] * 1.6 && ink[0] > ink[2] * 1.6;
      const faint = Math.abs(luma(ink) - luma(surface)) < 95;
      const c = container(img, box, surface, page);
      const wide = c.box.w > box.w * 2.2 && c.box.w > videoW * 0.2;
      const leftAligned = box.x - c.box.x < c.box.w * 0.15;
      if (reddish || (ERROR_WORDS.test(text) && words >= 2)) kind = 'error';
      else if (filled && !wide && words <= 6) { kind = 'button'; finalBox = c.box; }
      else if (c.outlined && wide && leftAligned) { kind = 'input'; finalBox = c.box; placeholder = faint; }
      else if (c.outlined && !wide && words <= 5 && c.box.h < box.h * 3.5) { kind = 'button'; finalBox = c.box; }
      else if (filled && wide && leftAligned && words <= 4 && faint) { kind = 'input'; finalBox = c.box; placeholder = true; }
    }
    if (kind === 'text') {
      if ((l as OcrLine & { bar?: boolean }).bar) kind = 'tab';
      else if (/:\s*\S/.test(text)) kind = 'value';
      else if (l.h >= typical * 1.45 && l.y < 0.6 && words <= 10) kind = 'title';
      else if (ERROR_WORDS.test(text) && words >= 3) kind = 'error';
    }
    out.push({ kind, text, box: finalBox, placeholder, conf: l.conf, textBox: box });
  }
  // Only the biggest heading near the top is the screen's title; others are section headings.
  const titles = out.filter((e) => e.kind === 'title').sort((a, b) => b.box.h - a.box.h || a.box.y - b.box.y);
  for (const t of titles.slice(1)) t.kind = 'text';
  return out;
}

/** Navigation and tab bars come back as one line ("Home Budgets Settings"): split into tabs. */
function splitBars(lines: OcrLine[]): (OcrLine & { bar?: boolean })[] {
  return lines.flatMap((l) => {
    const words = l.text.trim().split(/\s+/);
    const bar = (l.y < 0.15 || l.y + l.h > 0.85) && words.length >= 2 && words.length <= 7 && words.every((w) => /^\p{Lu}[\p{L}&'-]{1,14}$/u.test(w));
    if (!bar) return [l];
    // Spread by character count, which tracks real positions better than equal shares.
    const total = words.reduce((s, w) => s + w.length, 0) + words.length - 1;
    let offset = 0;
    return words.map((w) => {
      const part = { ...l, text: w, x: l.x + (l.w * offset) / total, w: (l.w * w.length) / total, bar: true };
      offset += w.length + 1;
      return part;
    });
  });
}

/** The screen's name: its title element, else the largest confident text near the top. */
export function screenTitle(els: UiElement[]): string {
  const t = els.find((e) => e.kind === 'title');
  if (t) return t.text;
  const c = els.filter((e) => e.kind === 'text' && e.box.y < 9999 && e.conf >= 0.6 && (e.text.match(/\p{L}/gu) ?? []).length >= 4).sort((a, b) => b.box.h - a.box.h)[0];
  return c?.text ?? '(untitled screen)';
}

/** The element a point falls on (or the nearest within reach), for "what was clicked". */
export function elementAt(els: UiElement[], x: number, y: number, reach = 40): UiElement | undefined {
  const inside = els.filter((e) => x >= e.box.x - 4 && x <= e.box.x + e.box.w + 4 && y >= e.box.y - 4 && y <= e.box.y + e.box.h + 4);
  if (inside.length) return inside.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
  let best: UiElement | undefined;
  let bestD = reach;
  for (const e of els) {
    const dx = Math.max(e.box.x - x, 0, x - (e.box.x + e.box.w));
    const dy = Math.max(e.box.y - y, 0, y - (e.box.y + e.box.h));
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** The label on the same row as a point, for controls without text (switches, checkboxes, icons). */
export function rowLabel(els: UiElement[], x: number, y: number): UiElement | undefined {
  return els
    .filter((e) => (e.kind === 'text' || e.kind === 'value') && y >= e.box.y - e.box.h && y <= e.box.y + e.box.h * 2 && e.box.x < x)
    .sort((a, b) => b.box.x + b.box.w - (a.box.x + a.box.w))[0];
}
