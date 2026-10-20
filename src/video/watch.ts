import { downloadVideo, ffmpeg, fmt, frameFile, fs, ocrImages, os, path, probe } from './media.js';
import { analyse, flickerMap, greyFrames, pointerAt, refinePointer, trackPointer, type Box, type Grid, type PointerSample, type Step } from './signal.js';
import { classify, elementAt, rgbFrame, rowLabel, screenTitle, type OcrLine, type UiElement } from './ui.js';

/**
 * Watching a screen recording the way a person does.
 *
 * A person doesn't look at a few stills. They follow the pointer, see what it
 * pressed, notice what changed and where (a new screen, a dialog, a toast, an
 * error under a field, a spinner, the page scrolling), read what was typed,
 * and remember screens they've seen before. This module does the same from
 * pixels alone, for any app on any platform, with no model:
 *
 *   signal  → where each frame changed, the pointer's path, scroll offsets
 *   actions → the changes grouped into actions and classified
 *   states  → each settled moment read (OCR) and understood (buttons, inputs…)
 *   story   → steps ("clicked Next → Set smart budgets"), screens, flow,
 *             timings, replay scripts
 *
 * Every step says how it is known: "seen" (the pointer was on it), "read"
 * (the text changed), or "inferred". Nothing is invented.
 */

export interface State {
  t: number;
  /** Elements on screen, classified. */
  els: UiElement[];
  title: string;
  /** A spinner was going and the screen had no content of its own. */
  loading?: boolean;
  /** Screen id this state belongs to (same screen seen again keeps its id). */
  screen: number;
  /** Text added on top of the screen (a dialog), when this state is an overlay. */
  overlay?: string[];
  file?: string;
}

export type ActionKind = 'click' | 'type' | 'scroll' | 'wait' | 'other';
export type ResultKind = 'navigate' | 'dialog-open' | 'dialog-close' | 'toast' | 'error' | 'change' | 'scroll' | 'loading' | 'none';

export interface Action {
  n: number;
  t: number;
  kind: ActionKind;
  /** What was acted on. */
  target?: { kind: string; text: string; box?: Box };
  /** How we know: the pointer was seen on it, the text changed, or a guess from context. */
  evidence: 'seen' | 'read' | 'inferred';
  pointer?: { x: number; y: number };
  typed?: string;
  scrollPx?: number;
  result: { kind: ResultKind; text: string };
  /** Time from the action to the screen settling. */
  responseSec?: number;
  loadingSec?: number;
  /** State index before and after. */
  from: number;
  to: number;
  said?: string;
}

export interface ScreenInfo {
  id: number;
  title: string;
  firstSeen: number;
  visits: number;
  els: UiElement[];
  variants: string[];
  stateIndex: number;
}

export interface Watched {
  source: string;
  duration: number;
  width: number;
  height: number;
  portrait: boolean;
  ocr: string;
  narrationEngine?: string;
  pointerSeen: boolean;
  states: State[];
  screens: ScreenInfo[];
  actions: Action[];
  notes: string[];
  trace?: Record<string, unknown>[];
  /** Kept for the report's images. */
  file: string;
  work: string;
  cleanup: () => Promise<void>;
}

export interface WatchOptions {
  /** Collect a per-change trace of decisions (for tuning). */
  debug?: boolean;
  ocr?: boolean;
  narration?: boolean;
  lang?: string;
  onProgress?: (msg: string) => void;
}

// ------------------------------------------------------------------ step 1: signal

interface Episode {
  start: number;
  end: number;
  steps: Step[];
  area: number;
  box: Box;
}

const SMALL = 2;
/** How far around its hotspot a cursor can cover text (an arrow or a touch dot is ~20 px). */
const CURSOR = 18;
/** Does a cursor resting at (x, y) cover any of this box? (arrows and dots reach further down/right) */
const covers = (r: { x: number; y: number }, b: Box) => r.x + 20 >= b.x && r.x - 10 <= b.x + b.w && r.y + 22 >= b.y && r.y - 10 <= b.y + b.h;
const HIDDEN = '\u0000hidden';
interface Slot { label: string; box: Box }

/** Keep only pointer sightings where it was travelling: spinners and blinking carets sit still. */
export function movingOnly(track: PointerSample[], blockPx: number): PointerSample[] {
  return track.filter((p, i) => {
    const prev = track[i - 1];
    const next = track[i + 1];
    const movedIn = !!prev && p.t - prev.t <= 0.6 && Math.hypot(p.x - prev.x, p.y - prev.y) >= blockPx * 0.6;
    const movedOut = !!next && next.t - p.t <= 0.6 && Math.hypot(next.x - p.x, next.y - p.y) >= blockPx * 0.6;
    return movedIn || movedOut;
  });
}

/**
 * Spots that flicker in place: a spinner (changes nearly every frame) or a
 * text caret (blinks). Returns, per small cell, the times it changed.
 */
function flickerCells(steps: Step[], g: Grid, pointer: PointerSample[]): Map<string, number[]> {
  const cellPx = (g.block * g.videoW) / g.w;
  const cells = new Map<string, number[]>();
  for (const s of steps) {
    for (const b of s.blobs) {
      if (b.blocks > SMALL) continue;
      const near = pointer.find((p) => Math.abs(p.t - s.t) < 0.11 && Math.hypot(p.x - b.cx, p.y - b.cy) < cellPx * 1.5);
      if (near) continue;
      const key = `${Math.round(b.cx / cellPx)},${Math.round(b.cy / cellPx)}`;
      cells.set(key, [...(cells.get(key) ?? []), s.t]);
    }
  }
  return cells;
}

/** Spinner intervals: one small spot changing in most frames for at least ~0.6 s. */
export function loadingSpans(cells: Map<string, number[]>, fps: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const times of cells.values()) {
    let i = 0;
    while (i < times.length) {
      let j = i;
      while (j + 1 < times.length && times[j + 1]! - times[j]! <= 2.5 / fps) j++;
      const dur = times[j]! - times[i]!;
      const density = (j - i + 1) / Math.max(1, dur * fps);
      if (dur >= 0.6 && density >= 0.55) spans.push({ start: times[i]!, end: times[j]! });
      i = j + 1;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function isFlicker(cells: Map<string, number[]>, b: { cx: number; cy: number; blocks: number }, t: number, cellPx: number): boolean {
  if (b.blocks > SMALL) return false;
  const times = cells.get(`${Math.round(b.cx / cellPx)},${Math.round(b.cy / cellPx)}`);
  if (!times) return false;
  return times.filter((x) => Math.abs(x - t) <= 1.2).length >= 3;
}

/** Group the frames where real content changed (not the pointer, not a caret or spinner) into episodes. */
export function episodes(steps: Step[], g: Grid, pointer: PointerSample[], cells: Map<string, number[]>): Episode[] {
  const cellPx = (g.block * g.videoW) / g.w;
  const out: Episode[] = [];
  let cur: Episode | undefined;
  for (const s of steps) {
    const content = s.area > 0.25 ? s.blobs : s.blobs.filter((b) => {
      if (isFlicker(cells, b, s.t, cellPx)) return false;
      const isPointer = b.blocks <= SMALL && pointer.some((p) => Math.abs(p.t - s.t) < 0.11 && Math.hypot(p.x - b.cx, p.y - b.cy) < cellPx * 1.6);
      return !isPointer;
    });
    if (!content.length) continue;
    const box = union(content.map((b) => b.box));
    const area = content.reduce((n, b) => n + b.blocks, 0) / (g.bx * g.by);
    if (cur && s.t - cur.end <= 0.35) {
      cur.end = s.t;
      cur.steps.push(s);
      cur.area = Math.max(cur.area, area);
      cur.box = union([cur.box, box]);
    } else {
      cur = { start: s.t - 1 / g.fps, end: s.t, steps: [s], area, box };
      out.push(cur);
    }
  }
  return out;
}

/** Share of a's letters found in b, in order-free fashion (for repairing a misread label). */
export function lettersShared(a: string, b: string): number {
  const pool = [...b.toLowerCase()];
  const letters = [...a.toLowerCase()].filter((c) => /\p{L}|\p{N}/u.test(c));
  if (!letters.length) return 0;
  let hit = 0;
  for (const c of letters) { const k = pool.indexOf(c); if (k >= 0) { hit++; pool.splice(k, 1); } }
  return hit / letters.length;
}

const iou = (a: Box, b: Box): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = x * y;
  return i ? i / (a.w * a.h + b.w * b.h - i) : 0;
};

const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

// ------------------------------------------------------------------ helpers on states

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}$@.,?!: -]+/gu, '').replace(/\s+/g, ' ').trim();
const texts = (st: State) => new Set(st.els.map((e) => norm(e.text)).filter((x) => x.length > 1));
/** Letters only: the same line read twice can differ in symbols and digits (₹ read as 7 or ·). */
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}]+/gu, '');
const looseSet = (els: UiElement[]) => new Set(els.map((e) => loose(e.text)).filter((x) => x.length > 2));
/** Two readings of one line that differ by at most one character: OCR noise, not a change. */
function sameReading(a: string, b: string): boolean {
  const x = norm(a).replace(/\s+/g, ''), y = norm(b).replace(/\s+/g, '');
  if (x === y) return true;
  if (/[?:]$/.test(x) !== /[?:]$/.test(y)) return false;
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(i + (x.length >= y.length ? 1 : 0)) === y.slice(i + (y.length >= x.length ? 1 : 0));
}

export function similarity(a: State, b: State): number {
  const sa = texts(a), sb = texts(b);
  if (!sa.size && !sb.size) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
}

/** Share of a's text that is still on b (for overlays: the dimmed screen behind a dialog). */
function kept(a: State, b: State): number {
  const sa = looseSet(a.els);
  if (!sa.size) return 0;
  const sb = looseSet(b.els);
  return [...sa].filter((x) => sb.has(x)).length / sa.size;
}

const added = (a: State, b: State) => b.els.filter((e) => !texts(a).has(norm(e.text)) && norm(e.text).length > 1);
const removed = (a: State, b: State) => a.els.filter((e) => !texts(b).has(norm(e.text)) && norm(e.text).length > 1);

/** Inputs whose content changed between two states: what was typed. */
function typedInto(a: State, b: State): { field: string; value: string; hidden: boolean; box: Box }[] {
  const out: { field: string; value: string; hidden: boolean; box: Box }[] = [];
  for (const before of a.els.filter((e) => e.kind === 'input' || e.kind === 'button' || e.kind === 'text')) {
    const after = b.els.find((e) => (e.kind === 'input' || e.kind === 'text') && Math.abs(e.box.y - before.box.y) < before.box.h * 0.6 && Math.abs(e.box.x - before.box.x) < 40);
    const field = before.placeholder ? before.text : undefined;
    if (before.kind === 'input' && !after) {
      // The placeholder vanished and nothing readable replaced it: a masked field.
      if (field && b.els.every((e) => norm(e.text) !== norm(field))) out.push({ field, value: '', hidden: true, box: before.box });
      continue;
    }
    if (!after || after.text === before.text) continue;
    if (before.kind === 'input' && before.placeholder) out.push({ field: before.text, value: after.text, hidden: /^[•·*.\s]+$/.test(after.text), box: before.box });
    else if (before.kind === 'input' && after.text.startsWith(before.text.slice(0, 3)) && after.text.length > before.text.length) out.push({ field: 'the field', value: after.text, hidden: false, box: before.box });
  }
  // Placeholder inputs that went blank in OCR (masked text OCR'd as nothing).
  return out;
}

// ------------------------------------------------------------------ watch

export async function watchVideo(source: string, opts: WatchOptions = {}): Promise<Watched> {
  const say = opts.onProgress ?? (() => {});
  const notes: string[] = [];
  let file = source;
  let dlCleanup: (() => Promise<void>) | undefined;
  if (/^https?:\/\//i.test(source)) {
    say('downloading the video');
    const dl = await downloadVideo(source);
    file = dl.file;
    dlCleanup = dl.cleanup;
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-watch-'));
  const cleanup = async () => {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await dlCleanup?.().catch(() => {});
  };
  try {
    const info = await probe(file);
    const W = info.width ?? 1280, H = info.height ?? 720;
    const vw = Math.min(W, 1280), vh = Math.round((H * vw) / W / 2) * 2;
    const fps = info.duration > 1800 ? 3 : info.duration > 600 ? 5 : 10;

    say(`watching ${Math.round(info.duration)} s at ${fps} frames a second`);
    const { grid, frames } = await greyFrames(file, fps, vw, vh);
    const steps = analyse(frames, grid);
    const blockPx = (grid.block * vw) / grid.w;
    const flicker = flickerMap(steps, grid);
    const pointer = movingOnly(trackPointer(steps, grid, flicker), blockPx);
    const cells = flickerCells(steps, grid, pointer);
    const loading = loadingSpans(cells, fps);
    const eps = episodes(steps, grid, pointer, cells);

    // Every place the pointer came to rest, located exactly (full-resolution check, once).
    say('locating every place the pointer stopped');
    const arrivals: PointerSample[] = [];
    for (let k = 0; k < pointer.length; k++) {
      const next = pointer[k + 1];
      if (!next || next.t - pointer[k]!.t > 0.35) {
        let j = k;
        while (j > 0 && pointer[j]!.t - pointer[j - 1]!.t <= 0.35) j--;
        const prevRest = arrivals.at(-1);
        const fine = await refinePointer(file, vw, vh, prevRest && { t: pointer[j]!.t - 0.1, x: prevRest.x, y: prevRest.y }, pointer[k]!).catch(() => undefined);
        arrivals.push({ t: pointer[k]!.t, x: fine?.x ?? pointer[k]!.x, y: fine?.y ?? pointer[k]!.y });
      }
    }

    // Exactly where the pointer was when each change began (full-resolution check).
    const clickPoint = async (e: Episode): Promise<{ x: number; y: number; t: number; recent: boolean } | undefined> => {
      const p = pointerAt(pointer, e.start + 0.05, 600);
      if (!p) return undefined;
      let k = pointer.indexOf(p);
      while (k > 0 && pointer[k]!.t - pointer[k - 1]!.t <= 0.35) k--;
      const rest = k > 0 ? pointer[k - 1] : undefined;
      const recent = e.start - p.t <= 1.5;
      const exact = pointerAt(arrivals, e.start + 0.05, 600);
      void rest;
      if (recent) return { x: exact?.x ?? p.x, y: exact?.y ?? p.y, t: p.t, recent };
      // The pointer may have moved where we couldn't follow it (through text being typed):
      // look for it near where the screen changed.
      if (eps.some((o) => o !== e && o.start > p.t && o.start < e.start && o.area > 0.25)) return { x: p.x, y: p.y, t: p.t, recent: false };
      const c = { t: e.start - 0.08, x: e.box.x + e.box.w / 2, y: e.box.y + e.box.h / 2 };
      const moved = await refinePointer(file, vw, vh, { t: p.t + 0.2, x: p.x, y: p.y }, c).catch(() => undefined);
      if (moved && Math.hypot(moved.x - p.x, moved.y - p.y) > 20) return { ...moved, t: e.start, recent: true };
      return { x: p.x, y: p.y, t: p.t, recent: false };
    };

    // States: the start, and wherever the picture settles after an episode.
    const stateTimes: number[] = [Math.min(0.4, Math.max(0, (eps[0]?.start ?? 1) - 0.1))];
    for (const [i, e] of eps.entries()) {
      const next = eps[i + 1]?.start ?? info.duration;
      const t = Math.min(e.end + 0.4, next - 0.05, info.duration - 0.05);
      if (t > stateTimes.at(-1)! + 0.05) stateTimes.push(Math.max(e.end + 0.05, t));
      else stateTimes.push(stateTimes.at(-1)!);
    }

    say(`${eps.length} changes found; reading ${stateTimes.length} moments`);
    const files = await Promise.all(stateTimes.map((t, i) => frameFile(file, t, path.join(work, `st${String(i).padStart(3, '0')}.png`), { scale: (2 * vw) / W })));
    let ocr = { engine: 'off', results: stateTimes.map(() => [] as OcrLine[]) };
    if (opts.ocr !== false) {
      ocr = await ocrImages(files);
      if (ocr.engine === 'none') notes.push('No OCR available (macOS uses Apple Vision automatically; elsewhere install tesseract): actions are described by position only.');
    }
    const states: State[] = [];
    for (const [i, t] of stateTimes.entries()) {
      const img = await rgbFrame(file, t, vw, vh).catch(() => undefined);
      const els = classify(ocr.results[i] ?? [], img, vw, vh);
      const isLoading = loading.some((l) => t >= l.start - 0.2 && t <= l.end + 0.2) && els.length <= 2;
      states.push({ t, els, title: isLoading ? 'Loading' : screenTitle(els), loading: isLoading, screen: 0, file: files[i] });
    }

    // Text under a resting pointer is often misread ("NE" for "Next"). If the same spot read
    // cleanly a moment earlier, with letters to match, use that reading.
    for (const [i, st] of states.entries()) {
      const r = pointerAt(arrivals, st.t, 600);
      if (!r) continue;
      for (const el of st.els) {
        const tb = el.textBox;
        if (!covers(r, tb)) continue;
        for (const prev of states.slice(Math.max(0, i - 4), i).reverse()) {
          const twin = prev.els.find((x) => x.conf >= 0.8 && x.text !== el.text && Math.abs(x.textBox.x - el.textBox.x) < 14 && Math.abs(x.textBox.w - el.textBox.w) < 30 && Math.abs(x.textBox.y - el.textBox.y) < 80);
          const sameSpot = !!twin && Math.abs(twin.textBox.x - el.textBox.x) < 8 && Math.abs(twin.textBox.y - el.textBox.y) < 8 && Math.abs(twin.textBox.w - el.textBox.w) < 16;
          if (twin && (lettersShared(el.text, twin.text) >= 0.5 || sameSpot)) {
            el.text = twin.text;
            el.conf = twin.conf;
            // The cursor can split one word into pieces ("Ne" + "KAT"): restore the word, drop the pieces.
            const span = { x: twin.textBox.x - 6, y: twin.textBox.y - 6, w: twin.textBox.w + 12, h: twin.textBox.h + 12 };
            if (Math.abs(twin.textBox.y - el.textBox.y) < 12) {
              el.textBox = twin.textBox;
              if (el.kind === twin.kind) el.box = twin.box;
              st.els = st.els.filter((x) => x === el || !(x.textBox.x >= span.x && x.textBox.x + x.textBox.w <= span.x + span.w && x.textBox.y >= span.y && x.textBox.y + x.textBox.h <= span.y + span.h));
            }
            break;
          }
        }
      }
      if (!st.loading) st.title = screenTitle(st.els);
    }

    // Where the pointer rests at each state: text under it is unreliable (OCR reads the cursor too).
    const restAt = (t: number) => pointerAt(arrivals, t, 600) ?? pointerAt(pointer, t, 600);
    const occluded = (e: UiElement, t: number) => {
      const r = restAt(t);
      return !!r && covers(r, e.textBox ?? e.box);
    };
    const visible = (st: State) => st.els.filter((e) => !occluded(e, st.t));
    const occludedBox = (box: Box, t: number) => { const r = restAt(t); return !!r && covers(r, box); };
    const vsim = (a: State, b: State) => {
      const sa = looseSet(visible(a)), sb = looseSet(visible(b));
      if (!sa.size && !sb.size) return 1;
      return [...sa].filter((x) => sb.has(x)).length / new Set([...sa, ...sb]).size;
    };
    // New and gone text, ignoring one-character OCR wobble between readings.
    const vadded = (a: State, b: State) => visible(b).filter((e) => norm(e.text).length > 1 && !a.els.some((x) => sameReading(x.text, e.text)));
    const vremoved = (a: State, b: State) => visible(a).filter((e) => norm(e.text).length > 1 && !b.els.some((x) => sameReading(x.text, e.text)));

    // Scrolls are decided from the signal alone: most of the change is the content moving up or down.
    const scrollOf = (e: Episode) => {
      const total = e.steps.reduce((n, x) => n + x.energy, 0);
      const moving = e.steps.filter((x) => x.shiftFit > 0.4 && Math.abs(x.shift) > 4);
      const share = total ? moving.reduce((n, x) => n + x.energy, 0) / total : 0;
      const px = moving.reduce((n, x) => n + x.shift, 0);
      return share >= 0.5 && Math.abs(px) > 30 ? px : 0;
    };
    // Text evidence: two or more lines that moved up or down together by the same amount.
    const textShift = (a: State, b: State): number => {
      const moves = a.els.flatMap((x) => { const y = b.els.find((z) => loose(z.text).length > 2 && loose(z.text) === loose(x.text) && Math.abs(z.box.x - x.box.x) < 16); return y ? [x.box.y - y.box.y] : []; });
      const big = moves.filter((d) => Math.abs(d) > 10).sort((m, n) => m - n);
      if (big.length < 2) return 0;
      const mid = big[Math.floor(big.length / 2)]!;
      const agree = big.filter((d) => Math.abs(d - mid) <= 8).length;
      return agree >= 2 && agree >= big.length * 0.6 ? mid : 0;
    };
    const scrolls = eps.map((e, i) => {
      const sig = scrollOf(e);
      if (sig) return sig;
      const total = e.steps.reduce((n, x) => n + x.energy, 0);
      const fitShare = total ? e.steps.filter((x) => x.shiftFit > 0.4).reduce((n, x) => n + x.energy, 0) / total : 0;
      const a = states[i], b = states[i + 1];
      if (!a || !b || a.loading || b.loading) return 0;
      const t = textShift(a, b);
      if (t && fitShare >= 0.4) return t;
      // The content moved and came back (a bounce at the end of the page): a scroll attempt.
      if (fitShare >= 0.6 && e.area > 0.08 && kept(a, b) >= 0.8) return Number.EPSILON * Math.sign(e.steps.find((x) => x.shiftFit > 0.4)?.shift ?? 1);
      return 0;
    });

    // Screens: the same screen keeps its id through edits, scrolls, errors and dialogs.
    const screens: ScreenInfo[] = [];
    const memory = new Map<number, UiElement[]>();
    const remember = (id: number, st: State) => {
      const mem = memory.get(id) ?? [];
      for (const e of visible(st)) {
        const same = mem.findIndex((m) => iou(m.box, e.box) > 0.5 || (Math.abs(m.box.y - e.box.y) < 8 && Math.abs(m.box.x - e.box.x) < 8));
        if (same < 0) mem.push(e);
        else if (e.conf >= mem[same]!.conf || mem[same]!.kind === 'text') mem[same] = { ...e, placeholder: mem[same]!.placeholder && e.kind === 'input' ? e.placeholder : mem[same]!.placeholder ?? e.placeholder, text: mem[same]!.placeholder && mem[same]!.kind === 'input' && !e.placeholder ? mem[same]!.text : e.text, kind: mem[same]!.kind === 'input' ? 'input' : e.kind };
      }
      memory.set(id, mem);
    };
    for (const [i, st] of states.entries()) {
      if (st.loading) { st.screen = -1; continue; }
      const prev = states.slice(0, i).reverse().find((x) => !x.loading);
      const ep = eps[i - 1];
      if (prev && ep) {
        // Still inside a dialog: its text is still showing.
        if (prev.overlay && prev.overlay.filter((t) => texts(st).has(norm(t))).length >= Math.ceil(prev.overlay.length / 2)) {
          st.screen = prev.screen; st.overlay = prev.overlay; st.title = prev.title; continue;
        }
        // A dialog opened: most of the screen is still behind it, plus new text, after a big change.
        const fresh = vadded(prev, st);
        if (!prev.overlay && ep.area > 0.35 && kept(prev, st) >= 0.6 && fresh.length >= 2) {
          st.screen = prev.screen;
          // The dialog's heading: its biggest text that isn't a button, then the rest in reading order.
          const heading = fresh.filter((e) => e.kind !== 'button').sort((a, b) => b.box.h - a.box.h || a.box.y - b.box.y)[0];
          st.overlay = [...(heading ? [heading] : []), ...fresh.filter((e) => e !== heading).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)].map((e) => e.text);
          st.title = prev.title;
          continue;
        }
        // Scrolled, edited, or showing an error: still the same screen.
        if (scrolls[i - 1] || (norm(st.title) === norm(prev.title) && vsim(prev, st) >= 0.15) || vsim(prev, st) >= 0.6) {
          const base = prev.overlay ? states.slice(0, i).reverse().find((x) => !x.loading && !x.overlay) ?? prev : prev;
          if (!prev.overlay || vsim(base, st) >= 0.5) {
            st.screen = prev.screen;
            st.title = screens.find((x) => x.id === prev.screen)?.title ?? st.title;
            remember(st.screen, st);
            continue;
          }
        }
      }
      const match = screens.find((x) => norm(x.title) === norm(st.title) && vsim(states[x.stateIndex]!, st) >= 0.3);
      if (match) {
        st.screen = match.id;
        st.title = match.title;
        match.visits++;
      } else {
        const id = screens.length + 1;
        screens.push({ id, title: st.title, firstSeen: st.t, visits: 1, els: st.els, variants: [], stateIndex: i });
        st.screen = id;
      }
      remember(st.screen, st);
    }
    for (const sc of screens) sc.els = memory.get(sc.id) ?? sc.els;

    // Input slots: each empty field seen with its placeholder, remembered by position,
    // so typing into it can be read back even after the placeholder is gone.
    const slots = new Map<number, Slot[]>();
    for (const st of states) {
      if (st.screen <= 0) continue;
      const list = slots.get(st.screen) ?? [];
      for (const el of st.els) {
        if (el.kind !== 'input' || occluded(el, st.t)) continue;
        const cy = el.box.y + el.box.h / 2;
        if (!list.some((x) => cy >= x.box.y && cy <= x.box.y + x.box.h)) list.push({ label: el.text, box: el.box });
      }
      slots.set(st.screen, list);
    }
    const slotValue = (slot: Slot, st: State): string | undefined => {
      if (st.screen <= 0) return undefined;
      const inside = st.els.filter((x) => x.box.y + x.box.h / 2 >= slot.box.y && x.box.y + x.box.h / 2 <= slot.box.y + slot.box.h && x.box.x >= slot.box.x - 6 && x.box.x < slot.box.x + slot.box.w);
      if (inside.some((x) => norm(x.text) === norm(slot.label))) return '';
      const text = inside.map((x) => x.text).join(' ').trim();
      if (/^[•·*.\s]+$/.test(text) || (!text && /pass|pin|secret|cvv|otp|code/i.test(slot.label))) return HIDDEN;
      return text || undefined;
    };

    // Actions: one per episode, explained.
    say('working out what was done at each step');
    const actions: Action[] = [];
    const lastTyped = new Map<string, Action>();
    let consumedUntil = -1;
    const trace: Record<string, unknown>[] = [];
    for (const [i, e] of eps.entries()) {
      const a = states[i]!, b = states[i + 1]!;
      const before = a.loading ? states.slice(0, i).reverse().find((x) => !x.loading) ?? a : a;
      const prevAct = actions.at(-1);
      const load = loading.find((l) => l.start < e.end + 0.3 && l.end > e.start - 0.3);

      // Scroll.
      if (scrolls[i]) {
        const revealed = vadded(before, b).slice(0, 4).map((x) => x.text);
        // Distance from lines of text seen in both moments (exact), else from the signal.
        const moves = visible(before).flatMap((x) => { const y = visible(b).find((z) => norm(z.text) === norm(x.text) && Math.abs(z.box.x - x.box.x) < 20); return y ? [x.box.y - y.box.y] : []; }).filter((d) => Math.abs(d) > 2).sort((m, n) => m - n);
        const px = Math.round(moves.length >= 2 ? moves[Math.floor(moves.length / 2)]! : scrolls[i]!);
        if (Math.abs(scrolls[i]!) < 1 && !moves.length) {
          actions.push({ n: 0, t: e.start, kind: 'scroll', evidence: 'seen', scrollPx: 0, result: { kind: 'scroll', text: `tried to scroll ${scrolls[i]! > 0 ? 'down' : 'up'} on "${b.title}", already at the end` }, from: i, to: i + 1 });
          continue;
        }
        if (prevAct?.kind === 'scroll' && e.start - prevAct.t < 4 && Math.sign(prevAct.scrollPx ?? 0) === Math.sign(px)) {
          prevAct.scrollPx = (prevAct.scrollPx ?? 0) + px;
          prevAct.to = i + 1;
          prevAct.result = { kind: 'scroll', text: `scrolled ${px > 0 ? 'down' : 'up'} about ${Math.abs(prevAct.scrollPx)} px on "${b.title}"${revealed.length ? `, revealing ${revealed.map((r) => `"${r}"`).join(', ')}` : ''}` };
        } else {
          actions.push({ n: 0, t: e.start, kind: 'scroll', evidence: 'seen', scrollPx: px, result: { kind: 'scroll', text: `scrolled ${px > 0 ? 'down' : 'up'} about ${Math.abs(px)} px on "${b.title}"${revealed.length ? `, revealing ${revealed.map((r) => `"${r}"`).join(', ')}` : ''}` }, from: i, to: i + 1 });
        }
        continue;
      }

      const tr: Record<string, unknown> = { i, start: +e.start.toFixed(2), end: +e.end.toFixed(2), area: +e.area.toFixed(3), box: [e.box.x, e.box.y, e.box.w, e.box.h].map(Math.round), scroll: scrolls[i] ? Math.round(scrolls[i]!) : 0, before: before.title, after: b.title, screens: [before.screen, b.screen] };
      if (opts.debug) trace.push(tr);
      // The pointer: exactly where it was when this change began. One arrival of the
      // pointer is one click; later changes without a new arrival are its consequences.
      const p = await clickPoint(e);
      const prevEp = eps[i - 1];
      const aftermath = !!prevEp && e.start - prevEp.end <= 0.6 && e.area < 0.03 && (prevEp.area > 0.05 || scrolls[i - 1] !== 0);
      const fresh = !!p?.recent && p.t > consumedUntil + 0.01 && !aftermath;
      tr.pointer = p ? { x: Math.round(p.x), y: Math.round(p.y), t: +p.t.toFixed(2), recent: p.recent, fresh } : null;
      const recent = fresh;
      if (fresh) consumedUntil = p!.t;
      const nearChange = !!p && p.x >= e.box.x - 60 && p.x <= e.box.x + e.box.w + 60 && p.y >= e.box.y - 60 && p.y <= e.box.y + e.box.h + 60;
      const inputs = slots.get(before.screen) ?? [];
      const slotOfLabel = (field: string) => inputs.find((sl) => sl.label === field)?.label;
      const inSlot = inputs.some((sl) => e.box.x >= sl.box.x - 10 && e.box.x + e.box.w <= sl.box.x + sl.box.w + 10 && e.box.y >= sl.box.y - 10 && e.box.y + e.box.h <= sl.box.y + sl.box.h + 10);
      // Without a fresh arrival, a big change under a resting pointer is still a likely click
      // (pressing the same button twice); small changes are consequences of the last click.
      const restingOn = p && !recent ? elementAt(before.els.concat(memory.get(before.screen) ?? []), p.x, p.y, 12) : undefined;
      const bigResult = b.screen !== before.screen || (!!b.overlay !== !!a.overlay);
      const resting = !!p && !recent && !inSlot && ((e.area > 0.3 && nearChange) || (bigResult && !!restingOn && ['button', 'tab', 'link'].includes(restingOn.kind)));
      const clicked = !!p && (recent || resting);
      const mem = memory.get(before.screen) ?? [];
      const pool = [...before.els, ...mem.filter((m) => !before.els.some((v) => iou(v.box, m.box) > 0.5))];
      const target = clicked ? elementAt(pool, p!.x, p!.y) : undefined;
      const label = clicked && !target ? rowLabel(pool, p!.x, p!.y) : undefined;

      // Typing: an input slot on this screen whose content changed.
      const typedNow: { field: string; value: string; hidden: boolean; box: Box }[] = [];
      for (const inp of inputs) {
        const was = slotValue(inp, before), now = slotValue(inp, b);
        if (now === undefined || now === was) continue;
        if (occludedBox(inp.box, b.t) && was && was !== HIDDEN && now.length < was.length) continue;
        typedNow.push({ field: inp.label, value: now, hidden: now === HIDDEN, box: inp.box });
      }
      if (inSlot && !typedNow.length) {
        const sl = inputs.find((x) => e.box.y + e.box.h / 2 >= x.box.y - 4 && e.box.y + e.box.h / 2 <= x.box.y + x.box.h + 4);
        if (sl && (/pass|pin|secret|cvv|otp|code/i.test(sl.label) || slotValue(sl, b) === HIDDEN)) typedNow.push({ field: sl.label, value: '', hidden: true, box: sl.box });
      }
      for (const ty of typedNow) {
        const open = lastTyped.get(ty.field);
        const focusClick = [...actions].reverse().find((x) => x.kind === 'click' && x.target?.kind === 'input' && x.target.text === ty.field);
        if (open) {
          open.typed = ty.hidden ? undefined : ty.value;
          open.result = { kind: 'change', text: ty.hidden ? `typed into "${ty.field}" (hidden: a password field)` : `typed "${ty.value}" into "${ty.field}"` };
          open.to = i + 1;
          continue;
        }
        const act: Action = { n: 0, t: focusClick ? focusClick.t + 0.01 : e.start, kind: 'type', target: { kind: 'input', text: ty.field, box: ty.box }, evidence: 'read', typed: ty.hidden ? undefined : ty.value, result: { kind: 'change', text: ty.hidden ? `typed into "${ty.field}" (hidden: a password field)` : `typed "${ty.value}" into "${ty.field}"` }, from: i, to: i + 1 };
        actions.push(act);
        lastTyped.set(ty.field, act);
      }

      // A click somewhere else ends any typing in progress.
      if (fresh && !inSlot) {
        const onField = target && inputs.some((sl) => { const cy = target.box.y + target.box.h / 2; return cy >= sl.box.y - 4 && cy <= sl.box.y + sl.box.h + 4; });
        for (const [field] of lastTyped) if (!onField || slotOfLabel(field) !== target?.text) lastTyped.delete(field);
      }

      // What the change was.
      let result: Action['result'] | undefined;
      if (b.overlay && !a.overlay) result = { kind: 'dialog-open', text: `opened "${b.overlay[0]}"` };
      else if (a.overlay && !b.overlay) result = { kind: 'dialog-close', text: `closed "${a.overlay[0]}"` };
      else if (b.loading) result = { kind: 'loading', text: 'started loading' };
      else if (b.screen !== before.screen && b.screen > 0) result = { kind: 'navigate', text: `went to "${b.title}"` };
      else {
        const inField = (x: UiElement) => inputs.some((sl) => { const cy = x.box.y + x.box.h / 2; return cy >= sl.box.y - 4 && cy <= sl.box.y + sl.box.h + 4; });
        const plus = vadded(before, b).filter((x) => !inField(x));
        const minus = vremoved(before, b).filter((x) => !inField(x));
        const errors = plus.filter((x) => x.kind === 'error');
        const transient = plus.length > 0 && states.slice(i + 2).some((c) => c.t - b.t <= 5 && c.screen === b.screen && plus.every((x) => !texts(c).has(norm(x.text))) && vsim(before, c) >= 0.6);
        if (errors.length) result = { kind: 'error', text: `showed error "${errors[0]!.text}"` };
        else if (transient) result = { kind: 'toast', text: `showed "${plus.map((x) => x.text).join(' ')}" briefly` };
        else if (plus.length || minus.length) result = { kind: 'change', text: [plus.length ? `added ${plus.slice(0, 3).map((x) => `"${x.text}"`).join(', ')}` : '', minus.length ? `removed ${minus.slice(0, 3).map((x) => `"${x.text}"`).join(', ')}` : ''].filter(Boolean).join('; ') };
        else if (clicked && label) result = { kind: 'change', text: `switched or toggled it (the picture changed there)` };
      }

      // The toast going away, a caret, a hover: not actions.
      if (prevAct?.result.kind === 'toast' && !recent && (!result || result.kind === 'change')) continue;
      if (!result && !(clicked && target)) continue;
      if (!result) result = target?.kind === 'input' ? { kind: 'none', text: `focused "${target.placeholder ? target.text : 'the field'}"` } : { kind: 'none', text: 'no visible change' };

      // Loading, then arrival: complete the action that started it.
      if (a.loading && prevAct && prevAct.result.kind === 'loading') {
        prevAct.result = result.kind === 'navigate' ? { kind: 'navigate', text: `${result.text} after loading` } : result;
        prevAct.to = i + 1;
        prevAct.loadingSec = load ? load.end - load.start : b.t - a.t;
        if (prevAct.responseSec !== undefined) prevAct.responseSec = b.t - prevAct.t;
        continue;
      }
      // Clicking an input then typing in it is one step.
      const slotOf = (bx: Box) => inputs.find((m) => { const cy = bx.y + bx.h / 2; return cy >= m.box.y - 4 && cy <= m.box.y + m.box.h + 4; });
      const focused = target?.kind === 'input' || (!!target && !!slotOf(target.box));
      const act: Action = {
        n: 0, t: e.start, kind: clicked ? 'click' : 'other', evidence: clicked ? 'seen' : 'inferred', result, from: i, to: i + 1,
        responseSec: clicked ? Math.max(0, b.t - e.start) : undefined,
        loadingSec: load ? load.end - load.start : undefined,
      };
      if (clicked) act.pointer = { x: Math.round(p!.x), y: Math.round(p!.y) };
      if (target) act.target = { kind: focused ? 'input' : target.kind, text: focused ? (slotOf(target.box)?.label ?? target.text) : target.text, box: target.box };
      else if (label) act.target = { kind: 'control', text: `the control next to "${label.text}"`, box: { x: p!.x - 14, y: p!.y - 14, w: 28, h: 28 } };
      if (!clicked && result.kind === 'navigate') {
        const guess = inferTap(before, b);
        if (guess) { act.kind = 'click'; act.target = { kind: guess.kind, text: guess.text, box: guess.box }; act.evidence = 'inferred'; }
      }
      if (resting) act.evidence = 'inferred';
      // A consequence of the previous click (a late redraw, the field reacting): fold it in.
      const lastAct = [...actions].reverse().find((x) => x.kind !== 'type');
      if (!clicked && lastAct && e.start - (lastAct.t + (lastAct.responseSec ?? 0)) <= 1.5 && ['change', 'none'].includes(result.kind) && lastAct.result.kind !== 'scroll') {
        if (lastAct.result.kind === 'none') lastAct.result = result;
        lastAct.to = i + 1;
        continue;
      }
      if (!clicked && ['change', 'none'].includes(result.kind)) continue;
      // A click on a field followed by typing reads better as one step.
      if (focused && result.kind === 'none') act.result = { kind: 'none', text: `focused the field` };
      actions.push(act);
    }
    // Typing steps come after the click that focused the field: order by time.
    actions.sort((x, y) => x.t - y.t || (x.kind === 'type' ? 1 : -1));
    actions.forEach((x, k) => (x.n = k + 1));

    // Narration, phrase by phrase, attached to the action it was said during.
    let narrationEngine: string | undefined;
    if (opts.narration !== false && info.audio) {
      say('listening to the narration');
      try {
        const { transcribeFile } = await import('../adapters/video.js');
        const t = await transcribeFile(file, { lang: opts.lang, allowEphemeral: true, prompt: screens.map((s) => s.title).join(', '), fine: true });
        narrationEngine = t.engine;
        for (const seg of t.segments) {
          const mid = (seg.start + seg.end) / 2;
          const act = [...actions].reverse().find((x) => x.t <= mid + 0.3) ?? actions[0];
          if (act) act.said = `${act.said ?? ''} ${seg.text}`.trim();
        }
      } catch (err) {
        notes.push(`Narration not transcribed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (!pointer.length) notes.push('No pointer or touch markers were visible, so taps are inferred from what changed (turn on "show touches" when recording a phone for exact taps).');

    // Variants per screen: dialogs and errors seen on it.
    for (const act of actions) {
      const st = states[act.to];
      const sc = screens.find((s) => s.id === st?.screen);
      if (!sc) continue;
      if (act.result.kind === 'dialog-open' || act.result.kind === 'error' || act.result.kind === 'toast') sc.variants.push(act.result.text.replace(/^(opened|showed( error)?)\s*/, ''));
    }

    return { source, duration: info.duration, width: vw, height: vh, portrait: vh > vw, ocr: ocr.engine, narrationEngine, pointerSeen: pointer.length > 0, states, screens, actions, notes, trace: opts.debug ? trace : undefined, file, work, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

const CTA = /^(get started|start|continue|next|sign ?up|sign ?in|log ?in|create account|save( changes)?|done|submit|confirm|ok(ay)?|allow|accept|agree|skip|finish|buy|pay|checkout|add|send|search|go)\b/i;

/** Without a visible pointer: the button named like the next screen, else a call to action that vanished. */
function inferTap(a: State, b: State): UiElement | undefined {
  const title = norm(b.title);
  const tappable = a.els.filter((e) => e.kind === 'button' || e.kind === 'tab' || e.kind === 'link');
  const named = tappable.find((e) => { const n = norm(e.text); return n.length >= 3 && (title === n || title.includes(n) || n.includes(title)); });
  if (named) return named;
  const after = texts(b);
  return tappable.find((e) => CTA.test(e.text.trim()) && !after.has(norm(e.text))) ?? tappable.find((e) => CTA.test(e.text.trim()));
}

// ------------------------------------------------------------------ images

export interface Picture {
  label: string;
  mimeType: 'image/jpeg';
  data: string;
}

/**
 * Evidence pictures: an overview of every screen side by side, then each key
 * action on the frame just before it, with the clicked element boxed in red
 * and the pointer marked in yellow.
 */
export async function pictures(w: Watched, max: number): Promise<Picture[]> {
  const out: Picture[] = [];
  if (max <= 0) return out;
  const firstStates = w.screens.map((s) => w.states[s.stateIndex]!);
  if (firstStates.length >= 2) {
    try {
      const thumbs = await Promise.all(firstStates.slice(0, 12).map((st, i) => frameFile(w.file, st.t, path.join(w.work, `th${String(i).padStart(2, '0')}.jpg`), { filter: `scale=${w.portrait ? 240 : 400}:-2` })));
      const cols = Math.min(4, thumbs.length);
      const rows = Math.ceil(thumbs.length / cols);
      const sheet = path.join(w.work, 'overview.jpg');
      await ffmpeg(['-framerate', '1', '-i', path.join(w.work, 'th%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=8:margin=8:color=white`, '-frames:v', '1', '-y', sheet]);
      out.push({ label: `Overview: ${firstStates.length} screens in order (${w.screens.map((s) => s.title).slice(0, 12).join(' · ')})`, mimeType: 'image/jpeg', data: (await fs.readFile(sheet)).toString('base64') });
    } catch {
      // overview is optional
    }
  }
  const important = w.actions.filter((a) => a.kind === 'click' && a.target?.box).sort((a, b) => rank(b) - rank(a)).slice(0, Math.max(0, max - out.length)).sort((a, b) => a.t - b.t);
  for (const a of important) {
    const b = a.target!.box!;
    const marks = [`drawbox=x=${Math.round(b.x - 4)}:y=${Math.round(b.y - 4)}:w=${Math.round(b.w + 8)}:h=${Math.round(b.h + 8)}:color=red@0.9:t=4`];
    if (a.pointer) marks.push(`drawbox=x=${a.pointer.x - 9}:y=${a.pointer.y - 9}:w=18:h=18:color=yellow@0.9:t=fill`);
    const f = path.join(w.work, `act${a.n}.jpg`);
    try {
      await frameFile(w.file, Math.max(0, a.t - 0.05), f, { filter: `scale=${w.width}:${w.height},${marks.join(',')}` });
      out.push({ label: `Step ${a.n} at ${fmt(a.t)}: ${describe(a)}`, mimeType: 'image/jpeg', data: (await fs.readFile(f)).toString('base64') });
    } catch {
      // skip this picture
    }
  }
  return out;
}

const rank = (a: Action) => ({ navigate: 5, 'dialog-open': 4, error: 4, toast: 3, loading: 3, 'dialog-close': 2, change: 2, scroll: 1, none: 0 } as Record<ResultKind, number>)[a.result.kind];

export function describe(a: Action): string {
  const tgt = a.target ? (a.target.kind === 'control' ? a.target.text : `"${a.target.text}"${a.target.kind !== 'text' ? ` ${a.target.kind}` : ''}`) : '';
  switch (a.kind) {
    case 'click': return `clicked ${tgt || `at (${a.pointer?.x}, ${a.pointer?.y})`} → ${a.result.text}`;
    case 'type': return a.result.text;
    case 'scroll': return a.result.text;
    case 'wait': return a.result.text;
    default: return a.result.text;
  }
}
