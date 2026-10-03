import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../dist/insights/features.js';
import { analyze, compareTopics, score, velocity, median } from '../dist/insights/analyze.js';

test('features: format, hook, length, structure and timing are detected', () => {
  const f = extractFeatures({ text: 'Introducing dots, always-on agents.', media: [{ type: 'video' }], createdAt: '2026-09-29T17:19:00Z' }, 'UTC');
  assert.equal(f.format, 'video');
  assert.equal(f.hook, 'announcement');
  assert.equal(f.length, 'short (<100)');
  assert.equal(f.daypart, 'afternoon (12–18)');
  assert.equal(f.weekday, 'Tue');
  assert.equal(extractFeatures({ text: 'x', isArticle: true }).format, 'article');
  assert.equal(extractFeatures({ text: '7 tools I use every day to ship faster' }).hook, 'list');
  assert.equal(extractFeatures({ text: 'How I built a 24/7 agent team' }).hook, 'how-to');
  assert.equal(extractFeatures({ text: 'Is anyone else seeing this?' }).hook, 'question');
  assert.equal(extractFeatures({ text: 'OpenAI is reportedly testing a new model' }).hook, 'news/leak');
  assert.equal(extractFeatures({ text: 'Steps:\n- one\n- two\n- three' }).structure, 'list/thread-style');
  assert.equal(extractFeatures({ text: 'Great launch 🚀' }).emoji, 'emoji');
});

test('score, velocity and median', () => {
  assert.equal(score({ metrics: { likes: 100, replies: 10 } }), 120);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  const p = { history: [{ t: '2026-10-01T00:00:00Z', likes: 100 }, { t: '2026-10-01T02:00:00Z', likes: 300 }] };
  assert.equal(velocity(p), 100);
  assert.equal(velocity({ history: [{ t: '2026-10-01T00:00:00Z', likes: 1 }] }), 0, 'one point is not a trend');
});

const post = (id, text, likes, f, extra = {}) => ({
  id, source: 'twitter', url: `https://x.com/a/status/${id}`, text, author: { handle: `u${id % 3}` },
  createdAt: '2026-10-01T10:00:00Z', firstSeenAt: '2026-10-01T10:00:00Z', lastSeenAt: '2026-10-01T10:00:00Z',
  features: { format: 'text', hook: 'other', length: 'short (<100)', structure: 'single block', numbers: 'no numbers', emoji: 'no emoji', hashtags: 'no hashtags', ...f },
  metrics: { likes, replies: 0 }, history: [], ...extra,
});

test('analyze: finds that video beats text when the data says so, and stays quiet otherwise', () => {
  const posts = [
    ...[1, 2, 3, 4, 5].map((i) => post(i, `video demo of the agent workflow ${i}`, 1000 + i, { format: 'video' })),
    ...[6, 7, 8, 9, 10].map((i) => post(i, `plain update number ${i}`, 100 + i, { format: 'text' })),
  ];
  const r = analyze('agents', posts);
  const fmt = r.dimensions.find((d) => d.key === 'format');
  assert.equal(fmt.buckets[0].value, 'video');
  assert.ok(r.findings.some((f) => /\*\*video\*\* posts get/.test(f)), r.findings.join('\n'));
  assert.equal(r.topPosts[0].features.format, 'video');
  assert.ok(r.phrases.some((p) => p.phrase.includes('video') || p.phrase.includes('demo')), JSON.stringify(r.phrases));

  const flat = analyze('agents', [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i, `same ${i}`, 100, { format: i % 2 ? 'video' : 'text' })));
  assert.equal(flat.findings.length, 0, 'no fake findings when every format performs the same');
  assert.ok(flat.sample.caveats.some((c) => /Small sample/.test(c)));
});

test('compareTopics ranks by momentum when history exists', () => {
  const grow = (id, from, to) => post(id, 't', to, {}, { history: [{ t: '2026-10-01T00:00:00Z', likes: from }, { t: '2026-10-01T01:00:00Z', likes: to }] });
  const rows = compareTopics([
    { topic: 'big but flat', posts: [grow(1, 5000, 5000), grow(2, 4000, 4000)] },
    { topic: 'small but rising', posts: [grow(3, 100, 400)] },
  ], Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(rows[0].topic, 'small but rising');
  assert.equal(rows[0].momentum, 300);
});

test('compareTopics only ranks on recent posts: an old viral post does not win today', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const old = { ...post(1, 'old', 10000, {}), createdAt: '2026-04-01T00:00:00Z' };
  const fresh = { ...post(2, 'fresh', 500, {}), createdAt: '2026-10-02T00:00:00Z' };
  const rows = compareTopics([{ topic: 'old giant', posts: [old] }, { topic: 'fresh', posts: [fresh] }], now, 7);
  assert.equal(rows[0].topic, 'fresh');
  assert.equal(rows[1].posts, 0);
  assert.equal(rows[1].tracked, 1);
});
