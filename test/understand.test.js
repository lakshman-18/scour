// Offline: watching a screen recording — screens, titles, controls, inferred taps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frameDiff, segment, titleOf, controlsOf, textSimilarity, inferAction } from '../dist/video/understand.js';

const sig = (v, patch = 0) => { const b = Buffer.alloc(64 * 36, v); for (let i = 0; i < patch; i++) b[i] = 255 - v; return b; };
const line = (text, y, h = 0.03, conf = 1) => ({ text, x: 0.05, y, w: 0.5, h, conf });

test('screen changes: a new screen splits, typing and noise do not, flashes are dropped', () => {
  const white = sig(240);
  const typed = sig(240, 10);        // a few characters typed: a tiny patch changes
  const dark = sig(40);              // a different screen
  const sigs = [white, white, white, typed, typed, white, dark, dark, dark, dark, white, dark, dark, dark];
  assert.ok(frameDiff(white, typed) < 1.5 && frameDiff(white, dark) > 50);
  const segs = segment(sigs, 2);
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 3], [3, 5], [5.5, 7]], 'the half-second flash back to white is a transition, not a screen');
});

test('screen title: the largest text near the top, not the clock or a paragraph', () => {
  const lines = [line('9:41', 0.01, 0.02), line('Create your account', 0.08, 0.066), line('It takes less than a minute.', 0.17, 0.035), line('Sign up', 0.44, 0.039)];
  assert.equal(titleOf(lines), 'Create your account');
  assert.equal(titleOf([]), '(untitled screen)');
});

test('controls: short tappable text; tab bars split; typed values, masked fields and label: value pairs skipped', () => {
  const lines = [line('Home Budgets Settings', 0.03), line('Settings', 0.1, 0.06), line('Currency: USD', 0.3), line('ana@example.com', 0.4), line('••••', 0.45), line('Save changes', 0.6), line('blurry', 0.7, 0.03, 0.4), line('This is a long sentence that explains the feature.', 0.5)];
  assert.deepEqual(controlsOf(lines, 'Settings'), ['Home', 'Budgets', 'Save changes']);
});

test('return visits and taps: same text means the same screen; the tap is named after the next screen or a call to action', () => {
  const home = [line('Good morning, Ana', 0.1, 0.06), line('Balance: $4,210', 0.3)];
  assert.ok(textSimilarity(home, [...home]) === 1 && textSimilarity(home, [line('Settings', 0.1)]) === 0);
  const screen = (title, controls, lines = []) => ({ id: 1, start: 0, end: 1, title, lines, controls, changes: [], said: '' });
  assert.deepEqual(inferAction(screen('Home', ['Home', 'Budgets', 'Settings']), screen('Settings', [])), { action: 'tapped "Settings"', confidence: 'likely' });
  assert.deepEqual(inferAction(screen('Create your account', ['Sign up']), screen('Good morning, Ana', [])), { action: 'tapped "Sign up"', confidence: 'likely' });
  assert.equal(inferAction(screen('Article', ['Share']), screen('Another article', [], [line('Share', 0.9)])), undefined, 'no guess without evidence');
});

test('end to end on a generated recording: three screens, one revisited', async (t) => {
  try { execFileSync('ffmpeg', ['-version']); } catch { return t.skip('ffmpeg not installed'); }
  const { understandVideo } = await import('../dist/video/understand.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'scour-u-'));
  try {
    const file = path.join(dir, 'rec.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2', '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1', '-pix_fmt', 'yuv420p', '-y', file]);
    const v = await understandVideo(file, { ocr: false, narration: false });
    assert.equal(v.screens.length, 3);
    assert.ok(Math.abs(v.duration - 6) < 0.2);
    assert.ok(v.screens.every((s) => s.frame?.data.length > 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
