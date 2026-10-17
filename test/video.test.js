// Offline: captions, chapters, most replayed, SponsorBlock cuts, frame choice and grabbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseJson3, parseVtt, pickCaptions, renderTranscript, mostReplayed, withoutSegments, frameTimes, grabFrames, fmtTime, ffmpegAvailable,
} from '../dist/adapters/video.js';

const info = (over = {}) => ({ id: 'v', chapters: [], heatmap: [], subtitles: {}, autoCaptions: {}, comments: [], formats: [], ...over });
const tr = (name) => [{ ext: 'vtt', url: `${name}.vtt` }, { ext: 'json3', url: name }];

test('json3 and WebVTT become timed segments; empty and repeated lines dropped', () => {
  const j = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] }, { tStartMs: 2000, segs: [{ utf8: '\n' }] }, { tStartMs: 65000, dDurationMs: 1000, segs: [{ utf8: 'later' }] }] });
  assert.deepEqual(parseJson3(j), [{ start: 0, end: 2, text: 'Hello there' }, { start: 65, end: 66, text: 'later' }]);
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<c>Hi</c> all\n\n00:00:03.500 --> 00:00:04.000\nHi all\n\n01:02:03.000 --> 01:02:04.000\nend';
  assert.deepEqual(parseVtt(vtt), [{ start: 1, end: 3.5, text: 'Hi all' }, { start: 3723, end: 3724, text: 'end' }]);
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(fmtTime(65), '1:05');
});

test('caption choice: human in the asked language, then auto, then YouTube translation; default the original', () => {
  const v = info({ language: 'en', subtitles: { 'es-ES': tr('human-es') }, autoCaptions: { 'en-orig': tr('auto-en'), fr: tr('tr-fr'), es: tr('tr-es') } });
  assert.deepEqual(pickCaptions(v, 'es'), { url: 'human-es', lang: 'es-ES', kind: 'human' });
  assert.deepEqual(pickCaptions(v, 'fr'), { url: 'tr-fr', lang: 'fr', kind: 'translated' });
  assert.deepEqual(pickCaptions(v, 'en'), { url: 'auto-en', lang: 'en', kind: 'auto' });
  assert.deepEqual(pickCaptions(v), { url: 'human-es', lang: 'es-ES', kind: 'human' }, 'any human track beats auto captions');
  assert.deepEqual(pickCaptions(info({ language: 'en', autoCaptions: { 'en-orig': tr('auto-en') } })), { url: 'auto-en', lang: 'en', kind: 'auto' });
  assert.equal(pickCaptions(info({ autoCaptions: { 'en-orig': tr('a') } }), 'de'), null);
  const dubbed = info({ language: 'en-US', autoCaptions: { 'ar-orig': tr('ar'), 'en-orig': tr('en'), 'fr-orig': tr('fr') } });
  assert.deepEqual(pickCaptions(dubbed), { url: 'en', lang: 'en', kind: 'auto' }, 'auto-dubbed video: the original language, not the first dub');
  assert.equal(pickCaptions(dubbed, 'fr').url, 'fr');
});

test('transcript: a section per chapter, ~45 s paragraphs, each linked to its moment', () => {
  const segs = Array.from({ length: 30 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: i % 10 === 9 ? `point ${i}.` : `word${i}` }));
  const md = renderTranscript(segs, [{ start: 0, end: 60, title: 'Intro' }, { start: 60, end: 150, title: 'Main part' }], (s) => `https://y/?t=${s}`);
  assert.match(md, /^### 0:00 Intro\n\n\[0:00\]\(https:\/\/y\/\?t=0\) word0/);
  assert.match(md, /### 1:00 Main part\n\n\[1:00\]\(https:\/\/y\/\?t=60\) word12/);
  assert.ok(md.split('\n\n').filter((p) => p.startsWith('[')).length >= 3, 'long chapters split into paragraphs');
  assert.doesNotMatch(renderTranscript(segs, []), /###/, 'no chapters: no headings');
});

test('most replayed: the peaks, not their neighbours, and not the intro everyone sees', () => {
  const heat = Array.from({ length: 100 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, value: i === 0 ? 1 : i === 40 ? 0.9 : i === 41 ? 0.85 : i === 70 ? 0.8 : 0.1 }));
  assert.deepEqual(mostReplayed(heat, 2).map((h) => h.start), [400, 700]);
});

test('SponsorBlock: segments inside a sponsor read are cut, the rest kept', () => {
  const segs = [{ start: 0, end: 5, text: 'a' }, { start: 60, end: 65, text: 'sponsor' }, { start: 66, end: 70, text: 'more' }, { start: 90, end: 95, text: 'b' }];
  assert.deepEqual(withoutSegments(segs, [{ start: 59.8, end: 70.2, category: 'sponsor' }]).map((s) => s.text), ['a', 'b']);
});

test('frame moments: most replayed first, then chapter starts past the title card, then evenly; never too close', () => {
  const t = frameTimes(600, [{ start: 0, end: 120, title: 'A' }, { start: 120, end: 600, title: 'B' }], [{ start: 300, end: 310 }], 3);
  assert.deepEqual(t.slice(0, 2).map((x) => [Math.round(x.at), x.label]), [[15, 'A'], [135, 'B']]);
  assert.ok(t.some((x) => !x.label), 'even fill-ins too');
  assert.ok(t.some((x) => x.label === 'most replayed' && x.at === 305));
  for (let i = 1; i < t.length; i++) assert.ok(t[i].at - t[i - 1].at >= 8, 'spaced out');
});

test('frames: grabbed from a real video, identical slides dropped', async (t) => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg not installed');
  const dir = mkdtempSync(path.join(tmpdir(), 'scour-v-'));
  try {
    // 4 s red, then 4 s of a moving test pattern.
    const file = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=4', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1', '-pix_fmt', 'yuv420p', '-y', file]);
    const frames = await grabFrames(file, [{ at: 1, label: 'red' }, { at: 2, label: 'red again' }, { at: 6, label: 'pattern' }], 5);
    assert.deepEqual(frames.map((f) => f.label), ['red', 'pattern'], 'the second red frame is a duplicate');
    assert.equal(frames[0].mimeType, 'image/jpeg');
    assert.ok(Buffer.from(frames[0].data, 'base64').length > 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
