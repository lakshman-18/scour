// Offline: the YouTube creator tools' scoring and analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreHook, lintTitle, checkChapters, suggestChapters, editDecisionList, findShorts, classifyComment, triageComments, median, analyzeRetention,
} from '../dist/youtube/creator.js';

test('hook: five properties; throat-clearing fails, a specific stakes-and-gap line passes', () => {
  assert.equal(scoreHook('Hey guys, welcome back to the channel').score, 1);
  const good = scoreHook('Why I stopped paying $200 a month for AI tools, and what you should use instead');
  assert.equal(good.score, 4, JSON.stringify(good.checks.filter((c) => !c.pass)));
  assert.equal(scoreHook('Nobody tells you why your 3 best videos flopped').score, 5);
});

test('title: truncation, shouting, vagueness, and a thumbnail that repeats the title', () => {
  const r = lintTitle('This INSANE AI Tool Will CHANGE Everything You Know About Coding Forever!!', 'INSANE AI TOOL');
  const msgs = r.issues.map((i) => i.message).join(' | ');
  assert.match(msgs, /74 characters/);
  assert.match(msgs, /vague words \(this, insane\)/);
  assert.match(msgs, /thumbnail repeats the title/);
  assert.equal(r.mobileView.length, 55);
  assert.equal(lintTitle('How I cut my AWS bill by 80% in one weekend', 'From $9k to $1.8k').issues.filter((i) => i.severity === 'fix').length, 0);
});

test('chapters: YouTube rules checked line by line', () => {
  assert.deepEqual(checkChapters('0:00 Intro\n1:30 Setup\n5:00 Demo', 600).problems, []);
  const bad = checkChapters('0:05 Intro\n0:10 Too short\n0:09 Backwards', 600).problems.join(' | ');
  assert.match(bad, /needs 0:00/);
  assert.match(bad, /lasts 5 s/);
  assert.match(bad, /not after the previous/);
});

test('chapters proposed where the vocabulary changes, labelled by distinctive words', () => {
  const topic = (from, to, w) => Array.from({ length: (to - from) / 5 }, (_, i) => ({ start: from + i * 5, end: from + i * 5 + 5, text: `${w} ${w}s and the ${w} again` }));
  const segs = [...topic(0, 300, 'pricing'), ...topic(300, 600, 'database'), ...topic(600, 900, 'deployment')];
  const ch = suggestChapters(segs, 900, 3);
  assert.equal(ch.length, 3);
  assert.equal(ch[0].start, 0);
  assert.ok(Math.abs(ch[1].start - 300) <= 30 && Math.abs(ch[2].start - 600) <= 30, ch.map((c) => c.start).join(','));
  assert.match(ch[1].title, /database/);
  assert.match(ch[2].title, /deployment/);
});

test('edit list: dead air, fillers and a retake with timecodes', () => {
  const r = editDecisionList([
    { start: 0, end: 3, text: 'um so today, uh, I want to show you' },
    { start: 5.5, end: 8, text: 'Today I want to show you the trick' },
    { start: 8.2, end: 10, text: 'it is basically free' },
  ]);
  assert.deepEqual(r.cues.map((c) => c.kind), ['filler', 'retake', 'dead air']);
  assert.equal(r.deadAirSec, 3);
  assert.equal(r.fillerCount, 3);
});

test('shorts: 20–58 s clips at natural breaks, ranked by replay, never overlapping', () => {
  const segs = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: i % 6 === 0 ? 'Here is why it works.' : 'more detail about it.' }));
  const heatmap = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, value: i >= 20 && i <= 24 ? 1 : 0.2 }));
  const clips = findShorts({ segments: segs, heatmap, chapters: [], comments: [] }, 'https://www.youtube.com/watch?v=x', 2);
  assert.equal(clips.length, 2);
  assert.ok(clips[0].start >= 190 && clips[0].start <= 250, `best clip starts in the replayed stretch, got ${clips[0].start}`);
  for (const c of clips) assert.ok(c.end - c.start >= 20 && c.end - c.start <= 58);
  assert.ok(clips[1].start >= clips[0].end || clips[1].end <= clips[0].start);
  assert.match(clips[0].cut, /^yt-dlp --download-sections "\*3:/);
});

test('comments: piles, and the pin is the most-liked real question', () => {
  assert.equal(classifyComment('Can we have a 2026 version please?'), 'request');
  assert.equal(classifyComment('How do I run this on Windows?'), 'question');
  assert.equal(classifyComment('This is misleading, the numbers are wrong'), 'criticism');
  assert.equal(classifyComment('Contact me on telegram for crypto signals'), 'spam');
  assert.equal(classifyComment('0:00 intro 1:20 setup 3:40 demo 5:00 outro? lol'), 'other');
  const r = triageComments([
    { text: 'Great video, thank you so much for this clear walkthrough of the whole setup process!', likes: 900 },
    { text: 'Does this work with the free plan or do I need Pro?', likes: 300 },
    { text: 'How?', likes: 999 },
  ]);
  assert.equal(r.pin.text, 'Does this work with the free plan or do I need Pro?');
});

test('retention export: hook leak, cliffs with what was said, end retention', () => {
  const rows = ['Video position (%),Absolute audience retention (%)'];
  for (let p = 0; p <= 100; p += 5) rows.push(`${p},${p === 0 ? 100 : p <= 5 ? 62 : p === 50 ? 40 : p > 50 ? 39 - (p - 50) / 10 : 60 - p / 5}`);
  const r = analyzeRetention(rows.join('\n'), 600, [{ start: 290, end: 305, text: 'now a long sponsor read' }]);
  assert.match(r.hookLeak.message, /hook leaks: only 62%/);
  const big = r.cliffs.sort((a, b) => b.drop - a.drop)[0];
  assert.deepEqual([big.at, big.drop, big.said], [300, 11, 'now a long sponsor read']);
  assert.equal(r.endRetention, 34);
  assert.equal(median([3, 1, 2]), 2);
});
