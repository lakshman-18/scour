// Offline: watching a screen recording — the pointer found by its shape, labels, steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCursor } from '../dist/video/signal.js';
import { describe, lettersShared, movingOnly, watchVideo } from '../dist/video/watch.js';

// A see-through cursor: a dark disc with a white outline, drawn over a background.
const W = 200, H = 120;
const disc = [];
for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) {
  const r = Math.hypot(dx, dy);
  if (r <= 11) disc.push({ dx, dy, alpha: r > 9 ? 1 : 0.65, ink: r > 9 ? 255 : 0 });
}
const frame = (bg, at) => {
  const img = Buffer.alloc(W * H, bg);
  for (let x = 20; x < 60; x++) for (let y = 90; y < 110; y++) img[y * W + x] = 30; // something dark elsewhere
  if (at) for (const p of disc) { const i = (at.y + p.dy) * W + at.x + p.dx; img[i] = Math.round(p.alpha * p.ink + (1 - p.alpha) * img[i]); }
  return img;
};
// The shape as learnt on a white page: the disc, plus a ring of what surrounds it.
const learnt = (() => {
  const img = frame(250, { x: 50, y: 50 });
  const px = disc.filter((p) => p.ink === 0).map((p) => ({ dx: p.dx, dy: p.dy, v: img[(50 + p.dy) * W + 50 + p.dx] }));
  const ring = [];
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
    const r = Math.hypot(dx, dy);
    if (r > 9 && r <= 12) ring.push({ dx, dy, v: img[(50 + dy) * W + 50 + dx] });
  }
  return { size: 15, px: [...px, ...ring], ring: ring.length };
})();

test('the pointer is found by its shape, over a different colour than it was learnt on', () => {
  for (const bg of [250, 110]) {
    const at = { x: 140, y: 40 };
    const got = findCursor(frame(bg, at), W, H, learnt);
    assert.ok(got && Math.hypot(got.x - at.x, got.y - at.y) <= 1, `found over background ${bg}: ${JSON.stringify(got)}`);
  }
  assert.equal(findCursor(frame(250), W, H, learnt), undefined, 'no pointer, no match (a dark block is not a cursor)');
});

test('misread labels: letters in common decide whether two readings are the same word', () => {
  assert.ok(lettersShared('Sigup', 'Sign up') >= 0.8);
  assert.ok(lettersShared('Seings', 'Settings') >= 0.8);
  assert.ok(lettersShared('Cancel', 'Log out') < 0.5);
});

test('pointer samples that never move (a spinner, a caret) are not the pointer', () => {
  const still = [0, 0.1, 0.2, 0.3].map((t) => ({ t, x: 300, y: 300 }));
  const moving = [1, 1.1, 1.2].map((t, i) => ({ t, x: 100 + i * 60, y: 200 }));
  const kept = movingOnly([...still, ...moving], 10);
  assert.deepEqual(kept.map((p) => p.t), [1, 1.1, 1.2]);
});

test('steps read as plain sentences', () => {
  const base = { n: 1, t: 2, evidence: 'seen', from: 0, to: 1 };
  assert.equal(describe({ ...base, kind: 'click', target: { kind: 'button', text: 'Sign up' }, result: { kind: 'error', text: 'showed error "Password too short"' } }), 'clicked "Sign up" button → showed error "Password too short"');
  assert.equal(describe({ ...base, kind: 'click', target: { kind: 'control', text: 'the control next to "Notifications"' }, result: { kind: 'toast', text: 'showed "Saved" briefly' } }), 'clicked the control next to "Notifications" → showed "Saved" briefly');
});

test('end to end on a generated recording: screens are told apart without OCR', async (t) => {
  try { execFileSync('ffmpeg', ['-version']); } catch { return t.skip('ffmpeg not installed'); }
  const dir = mkdtempSync(path.join(tmpdir(), 'scour-w-'));
  try {
    const file = path.join(dir, 'rec.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2', '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1', '-pix_fmt', 'yuv420p', '-y', file]);
    const w = await watchVideo(file, { ocr: false, narration: false });
    try {
      assert.ok(Math.abs(w.duration - 6) < 0.2);
      assert.ok(w.states.length >= 3, `states: ${w.states.length}`);
      assert.equal(w.pointerSeen, false);
    } finally {
      await w.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
