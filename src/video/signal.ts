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

/**
 * What the pointer looks like. Learnt from the places it was seen arriving for
 * certain: the pixels that are the cursor (they differ from the same spot once
 * it has gone) and their shades. With this, the pointer can be found in any
 * single frame by its shape, the way a person spots it, even while the screen
 * under it is changing, which is when motion tracking loses it.
 */
export interface CursorShape {
  size: number;
  /** Offsets (from the patch centre) and shades: the cursor's own pixels, then a ring of what surrounds it. */
  px: { dx: number; dy: number; v: number }[];
  ring: number;
}

export async function learnCursor(file: string, w: number, h: number, seen: { t: number; x: number; y: number; gone: number }[]): Promise<CursorShape | undefined> {
  const S = 15;
  const votes = new Map<string, { on: number[]; hit: number }>();
  let used = 0;
  for (const s of seen.slice(0, 16)) {
    if (used >= 6) break;
    const [on, off] = await Promise.all([greyFull(file, s.t + 0.12, w, h), greyFull(file, s.gone, w, h)]).catch(() => [undefined, undefined]);
    if (!on || !off) continue;
    // The change at this sighting must be a small blob: if it reaches the edge of the window,
    // something else changed too (a button's hover colour) and it would teach the wrong shape.
    const D = 2 * S + 1;
    const hit = new Uint8Array(D * D);
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      const x = Math.round(s.x + dx), y = Math.round(s.y + dy);
      if (x >= 0 && y >= 0 && x < w && y < h && Math.abs(on[y * w + x]! - off[y * w + x]!) > 30) hit[(dy + S) * D + dx + S] = 1;
    }
    let seed = -1, bestD = Infinity;
    for (let k = 0; k < hit.length; k++) if (hit[k]) { const d = Math.hypot((k % D) - S, Math.floor(k / D) - S); if (d < bestD) { bestD = d; seed = k; } }
    if (seed < 0 || bestD > 6) continue;
    const blob = new Uint8Array(D * D);
    const stack = [seed];
    blob[seed] = 1;
    let edge = false;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % D, qy = Math.floor(q / D);
      if (qx === 0 || qy === 0 || qx === D - 1 || qy === D - 1) edge = true;
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const nx = qx + ox, ny = qy + oy;
        if (nx < 0 || ny < 0 || nx >= D || ny >= D) continue;
        const nk = ny * D + nx;
        if (hit[nk] && !blob[nk]) { blob[nk] = 1; stack.push(nk); }
      }
    }
    if (edge) continue;
    used++;
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      const x = Math.round(s.x + dx), y = Math.round(s.y + dy);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = `${dx},${dy}`;
      const e = votes.get(k) ?? votes.set(k, { on: [], hit: 0 }).get(k)!;
      e.on.push(on[y * w + x]!);
      if (blob[(dy + S) * D + dx + S]) e.hit++;
    }
  }
  if (used < 2) return undefined;
  const median = (vs: number[]) => [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)]!;
  const core = new Set<string>();
  for (const [k, e] of votes) if (e.hit >= Math.ceil(used * 0.6)) core.add(k);
  // Too few pixels is noise; a whole block is a changing panel, not a cursor.
  if (core.size < 12 || core.size > (2 * S + 1) ** 2 * 0.6) return undefined;
  const px: CursorShape['px'] = [];
  for (const k of core) { const [dx, dy] = k.split(',').map(Number) as [number, number]; px.push({ dx, dy, v: median(votes.get(k)!.on) }); }
  // The ring: pixels within 3 of the cursor but not part of it (they give it its outline).
  const ring: CursorShape['px'] = [];
  for (const [k, e] of votes) {
    if (core.has(k)) continue;
    const [dx, dy] = k.split(',').map(Number) as [number, number];
    let near = false;
    for (let oy = -3; oy <= 3 && !near; oy++) for (let ox = -3; ox <= 3 && !near; ox++) near = core.has(`${dx + ox},${dy + oy}`);
    if (near) ring.push({ dx, dy, v: median(e.on) });
  }
  return { size: S, px: [...px, ...ring], ring: ring.length };
}

/**
 * Where the pointer is in one frame, or undefined when it isn't visible. Matched by
 * normalised correlation over the cursor and its outline, so a see-through cursor
 * (or a touch dot) is found over any colour, not only the one it was learnt on.
 */
export function findCursor(img: Buffer, w: number, h: number, shape: CursorShape, near?: { x: number; y: number; r: number }): { x: number; y: number; score: number } | undefined {
  const S = shape.size;
  const n = shape.px.length;
  const tm = shape.px.reduce((a, p) => a + p.v, 0) / n;
  const tv = shape.px.map((p) => p.v - tm);
  const tn = Math.sqrt(tv.reduce((a, v) => a + v * v, 0)) || 1;
  const offs = shape.px.map((p) => p.dy * w + p.dx);
  const ncc = (cx: number, cy: number) => {
    const base = cy * w + cx;
    let sum = 0, sq = 0, dot = 0;
    for (let i = 0; i < n; i++) { const v = img[base + offs[i]!]!; sum += v; sq += v * v; dot += v * tv[i]!; }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    if (sd < 10) return -1;
    return dot / (tn * sd * Math.sqrt(n));
  };
  const x0 = Math.max(S, near ? Math.round(near.x - near.r) : S), x1 = Math.min(w - S - 1, near ? Math.round(near.x + near.r) : w - S - 1);
  const y0 = Math.max(S, near ? Math.round(near.y - near.r) : S), y1 = Math.min(h - S - 1, near ? Math.round(near.y + near.r) : h - S - 1);
  let best = { x: 0, y: 0, c: 0.55 };
  for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x += 3) {
    const c = ncc(x, y);
    if (c > best.c) best = { x, y, c };
  }
  if (best.c <= 0.55) return undefined;
  const coarse = best;
  for (let yy = Math.max(y0, coarse.y - 2); yy <= Math.min(y1, coarse.y + 2); yy++) for (let xx = Math.max(x0, coarse.x - 2); xx <= Math.min(x1, coarse.x + 2); xx++) {
    const c = ncc(xx, yy);
    if (c > best.c) best = { x: xx, y: yy, c };
  }
  if (best.c < 0.72) return undefined;
  return { x: best.x, y: best.y, score: 1 - best.c };
}

/** A stretch of full-size grey frames (one ffmpeg call), for following the pointer closely. */
export async function greySpan(file: string, from: number, to: number, fps: number, w: number, h: number): Promise<{ t: number; img: Buffer }[]> {
  const start = Math.max(0, from);
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', file, '-t', Math.max(0.05, to - start).toFixed(3), '-vf', `fps=${fps},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: 120_000,
  } as never);
  const buf = stdout as unknown as Buffer;
  const n = Math.floor(buf.length / (w * h));
  return Array.from({ length: n }, (_, i) => ({ t: start + i / fps, img: buf.subarray(i * w * h, (i + 1) * w * h) }));
}
