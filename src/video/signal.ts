import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The low-level "eye": the video as small grey frames, and for every pair of
 * consecutive frames, *where* it changed and *how*. CAPdroid showed that the
 * frame-to-frame change signal is what separates a tap from a scroll from
 * typing; we add where the change is, so the cursor, a spinner, a toast and
 * a whole new screen each look different.
 */

export interface Grid {
  /** Analysis frame size (pixels). */
  w: number;
  h: number;
  /** Size of one change block, in analysis pixels. */
  block: number;
  bx: number;
  by: number;
  fps: number;
  /** Video size, to map analysis pixels back to the real frame. */
  videoW: number;
  videoH: number;
}

export interface Blob {
  /** Changed blocks in this connected patch. */
  blocks: number;
  /** Bounding box in video pixels. */
  box: Box;
  /** Centre of the changed pixels, in video pixels. */
  cx: number;
  cy: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Step {
  /** Time of the later frame. */
  t: number;
  /** Mean absolute luminance change (0–255), ignoring compression noise. */
  energy: number;
  /** Fraction of blocks that changed. */
  area: number;
  blobs: Blob[];
  /** Vertical content shift that best explains the change (video px; + = content moved up = scrolled down). */
  shift: number;
  /** How much of the change the shift explains (0–1). */
  shiftFit: number;
}

export async function greyFrames(file: string, fps: number, videoW: number, videoH: number): Promise<{ grid: Grid; frames: Buffer[] }> {
  const w = 160;
  const h = Math.max(36, Math.round((w * videoH) / Math.max(1, videoW) / 2) * 2);
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: 60 * 60_000,
  } as never);
  const buf = stdout as unknown as Buffer;
  const frames: Buffer[] = [];
  for (let i = 0; i + w * h <= buf.length; i += w * h) frames.push(buf.subarray(i, i + w * h));
  const block = 10;
  return { grid: { w, h, block, bx: Math.ceil(w / block), by: Math.ceil(h / block), fps, videoW, videoH }, frames };
}

const NOISE = 18;

/** What changed between two frames, and where. */
export function compare(a: Buffer, b: Buffer, g: Grid, t: number): Step {
  const { w, h, block, bx, by } = g;
  const sx = g.videoW / w;
  const sy = g.videoH / h;
  const changed = new Uint8Array(bx * by);
  const sumX = new Float64Array(bx * by);
  const sumY = new Float64Array(bx * by);
  const cnt = new Uint32Array(bx * by);
  let energy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(a[y * w + x]! - b[y * w + x]!);
      if (d <= NOISE) continue;
      energy += d;
      const k = Math.floor(y / block) * bx + Math.floor(x / block);
      cnt[k]!++;
      sumX[k]! += x;
      sumY[k]! += y;
    }
  }
  for (let k = 0; k < cnt.length; k++) if (cnt[k]! > 3) changed[k] = 1;
  energy /= w * h;

  // Connected patches of changed blocks (8-neighbourhood).
  const seen = new Uint8Array(bx * by);
  const blobs: Blob[] = [];
  for (let k = 0; k < changed.length; k++) {
    if (!changed[k] || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let n = 0, px = 0, py = 0, c = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qx = q % bx, qy = Math.floor(q / bx);
      px += sumX[q]!; py += sumY[q]!; c += cnt[q]!;
      minX = Math.min(minX, qx); maxX = Math.max(maxX, qx); minY = Math.min(minY, qy); maxY = Math.max(maxY, qy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= bx || ny >= by) continue;
        const nk = ny * bx + nx;
        if (changed[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    blobs.push({
      blocks: n,
      box: { x: minX * block * sx, y: minY * block * sy, w: (maxX - minX + 1) * block * sx, h: (maxY - minY + 1) * block * sy },
      cx: (px / c) * sx,
      cy: (py / c) * sy,
    });
  }
  const area = changed.reduce((s, v) => s + v, 0) / changed.length;

  // Scroll: the vertical offset under which the frames match best.
  let shift = 0;
  let shiftFit = 0;
  if (area > 0.05) {
    const err = (dy: number) => {
      let e = 0, n = 0;
      for (let y = Math.max(0, dy); y < h + Math.min(0, dy); y += 2) for (let x = 0; x < w; x += 2) { e += Math.abs(a[(y - dy) * w + x]! - b[y * w + x]!); n++; }
      return n ? e / n : Infinity;
    };
    const e0 = err(0);
    let best = 0, bestE = e0;
    const span = Math.floor(h / 3);
    for (let dy = -span; dy <= span; dy++) {
      if (!dy) continue;
      const e = err(dy);
      if (e < bestE) { bestE = e; best = dy; }
    }
    if (best && e0 > 0) {
      shift = -best * sy;
      shiftFit = Math.max(0, 1 - bestE / e0);
    }
  }
  return { t, energy, area, blobs, shift, shiftFit };
}

export function analyse(frames: Buffer[], g: Grid): Step[] {
  const steps: Step[] = [];
  for (let k = 1; k < frames.length; k++) steps.push(compare(frames[k - 1]!, frames[k]!, g, k / g.fps));
  return steps;
}

export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

/**
 * Follow the pointer: a small patch (one or two blocks) that keeps moving.
 * Screen recorders draw the cursor (desktop) or a touch dot (phones with
 * "show touches"); either way it's the only small thing that travels.
 * Returns where the pointer was seen, frame by frame.
 */
export function trackPointer(steps: Step[], g: Grid, flicker?: Flicker): PointerSample[] {
  const out: PointerSample[] = [];
  const blockPx = (g.block * g.videoW) / g.w;
  let last: PointerSample | undefined;
  for (const s of steps) {
    // Carets and spinners flicker in place; they are never the pointer.
    const small = s.blobs.filter((b) => b.blocks <= 3 && !flicker?.at(b, s.t));
    if (!small.length || s.area > 0.25) continue;
    // Prefer the patch nearest to where the pointer was; a moving pointer
    // leaves two patches (where it left and where it is), take the far end
    // along its direction of travel.
    let pick = small[0]!;
    if (last) {
      // A moving pointer leaves two patches: where it was (erased) and where
      // it is now. The one sitting on the last known position is the old one.
      const fresh = small.filter((b) => dist(b, last!) > blockPx * 1.5);
      pick = fresh.length
        ? fresh.reduce((a, b) => (dist(b, last!) < dist(a, last!) ? b : a))
        : small.reduce((a, b) => (dist(b, last!) < dist(a, last!) ? b : a));
    }
    const sample = { t: s.t, x: pick.cx, y: pick.cy };
    // A jump across the screen with nothing in between is not the pointer
    // (a blinking caret elsewhere, a spinner); keep it only if it repeats.
    if (last && dist(pick, last) > g.videoW * 0.35 && s.t - last.t < 0.3) continue;
    out.push(sample);
    last = sample;
  }
  return out;
}

const dist = (a: { cx?: number; cy?: number; x?: number; y?: number }, b: { x: number; y: number }) =>
  Math.hypot((a.cx ?? a.x!) - b.x, (a.cy ?? a.y!) - b.y);

/** Where the pointer was at time t: the last sighting at or before t (within `maxAge` seconds). */
export function pointerAt(track: PointerSample[], t: number, maxAge = 2.5): PointerSample | undefined {
  let found: PointerSample | undefined;
  for (const p of track) {
    if (p.t > t + 0.05) break;
    found = p;
  }
  return found && t - found.t <= maxAge ? found : undefined;
}

/** Mean absolute difference of two grey frames, with noise ignored (0–255). */
export function frameDistance(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > NOISE) s += d;
  }
  return s / a.length;
}

/** Mean difference inside one region of two grey frames (box in video pixels). */
export function regionDistance(a: Buffer, b: Buffer, g: Grid, box: Box): number {
  const sx = g.w / g.videoW, sy = g.h / g.videoH;
  const x0 = Math.max(0, Math.floor(box.x * sx)), x1 = Math.min(g.w, Math.ceil((box.x + box.w) * sx));
  const y0 = Math.max(0, Math.floor(box.y * sy)), y1 = Math.min(g.h, Math.ceil((box.y + box.h) * sy));
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += Math.abs(a[y * g.w + x]! - b[y * g.w + x]!); n++; }
  return n ? s / n : 0;
}

/**
 * Spots that flicker in place (a text caret blinking, a spinner turning, a
 * progress bar): small patches that keep changing at the same spot. The
 * pointer only passes through a spot once or twice, then moves on or rests.
 */
export interface Flicker {
  /** Times each small cell changed. */
  cells: Map<string, number[]>;
  cellPx: number;
  at(b: { cx: number; cy: number; blocks: number }, t: number): boolean;
}

export function flickerMap(steps: Step[], g: Grid): Flicker {
  const cellPx = (g.block * g.videoW) / g.w;
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.round(x / cellPx)},${Math.round(y / cellPx)}`;
  for (const s of steps) for (const b of s.blobs) if (b.blocks <= 2) {
    const k = key(b.cx, b.cy);
    cells.set(k, [...(cells.get(k) ?? []), s.t]);
  }
  return {
    cells,
    cellPx,
    at(b, t) {
      if (b.blocks > 2) return false;
      const times = cells.get(key(b.cx, b.cy));
      return !!times && times.filter((x) => Math.abs(x - t) <= 1.2).length >= 4;
    },
  };
}

/** One full-resolution grey frame (for exact positions). */
export async function greyFull(file: string, t: number, w: number, h: number): Promise<Buffer> {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  } as never);
  return stdout as unknown as Buffer;
}

/**
 * Exactly where the pointer stopped: compare a full-size frame from before
 * it set off with one after it arrived. The difference is the cursor in two
 * places, sharp; the patch away from where it started is where it is now.
 * Returns the centre of that patch, or undefined when it can't be told apart.
 */
export async function refinePointer(
  file: string, w: number, h: number,
  from: { t: number; x: number; y: number } | undefined,
  to: { t: number; x: number; y: number },
): Promise<{ x: number; y: number } | undefined> {
  const before = from ? from.t - 0.05 : to.t - 1;
  const [a, b] = await Promise.all([greyFull(file, before, w, h), greyFull(file, to.t + 0.12, w, h)]);
  const R = 140;
  const x0 = Math.max(0, Math.round(to.x - R)), x1 = Math.min(w, Math.round(to.x + R));
  const y0 = Math.max(0, Math.round(to.y - R)), y1 = Math.min(h, Math.round(to.y + R));
  // Changed pixels in the window, grouped into patches on a 6-pixel lattice.
  const cell = 6;
  const cw = Math.ceil((x1 - x0) / cell), ch = Math.ceil((y1 - y0) / cell);
  const hit = new Uint8Array(cw * ch);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (Math.abs(a[y * w + x]! - b[y * w + x]!) > 40) hit[Math.floor((y - y0) / cell) * cw + Math.floor((x - x0) / cell)] = 1;
  }
  const seen = new Uint8Array(cw * ch);
  const patches: { x: number; y: number; n: number }[] = [];
  for (let k = 0; k < hit.length; k++) {
    if (!hit[k] || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let n = 0, sx = 0, sy = 0;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qx = q % cw, qy = Math.floor(q / cw);
      sx += qx; sy += qy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const nk = ny * cw + nx;
        if (hit[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    patches.push({ x: x0 + (sx / n + 0.5) * cell, y: y0 + (sy / n + 0.5) * cell, n });
  }
  // Which frame has the cursor at each patch: the one whose pixels there stand out more
  // from the colour around the patch. We want patches where the later frame has it.
  const standOut = (img: Buffer, cx: number, cy: number) => {
    const r = 9, ring: number[] = [], core: number[] = [];
    for (let dy = -r - 6; dy <= r + 6; dy += 3) for (let dx = -r - 6; dx <= r + 6; dx += 3) {
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      (Math.abs(dx) <= r && Math.abs(dy) <= r ? core : ring).push(img[y * w + x]!);
    }
    ring.sort((p, q) => p - q);
    const bg = ring[Math.floor(ring.length / 2)] ?? 0;
    return core.reduce((n, v) => n + Math.abs(v - bg), 0) / Math.max(1, core.length);
  };
  // A cursor is small: between ~2 and ~40 lattice cells.
  const cand = patches.filter((p) => p.n >= 2 && p.n <= 40 && standOut(b, p.x, p.y) >= standOut(a, p.x, p.y) && (!from || Math.hypot(p.x - from.x, p.y - from.y) > 18));
  if (!cand.length) return undefined;
  return cand.reduce((p, q) => (Math.hypot(q.x - to.x, q.y - to.y) < Math.hypot(p.x - to.x, p.y - to.y) ? q : p));
}
