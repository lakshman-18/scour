// Offline: query operators, exact-spelling matching, the pipeline's "what was
// hidden" notes, X profile timelines and X archive import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseQuery, matchQuery, spellingOf } from '../dist/core/query.js';
import { Scour } from '../dist/core/pipeline.js';
import { Registry } from '../dist/core/registry.js';
import { NullCache } from '../dist/core/cache.js';
import { Tier } from '../dist/core/types.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'scour-q-'));
const post = (text, author) => ({ title: text, snippet: text, url: 'https://x.com/a/status/1', source: 'twitter', author });

test('parseQuery: operators come out, the engine query keeps words, phrases and site:', () => {
  const q = parseQuery('ToolMark -forensic -"tool mark" "no code" from:@SomeOne site:x.com');
  assert.equal(q.text, 'ToolMark "no code" site:x.com');
  assert.deepEqual(q.exact, ['ToolMark']);
  assert.deepEqual(q.exclude, ['forensic', 'tool mark']);
  assert.deepEqual(q.phrases, ['no code']);
  assert.deepEqual(q.from, ['someone']);
  assert.deepEqual(parseQuery('toolmark AI agents').exact, [], 'lowercase words and acronyms are not names');
  assert.deepEqual(parseQuery('long-running agents').exclude, [], 'a hyphen inside a word is not an exclusion');
});

test('names keep their spelling: "ToolMark" is not the forensic "toolmark"', () => {
  const q = parseQuery('ToolMark');
  const yes = ['Just shipped ToolMark v2', 'TOOLMARK is live', 'built with @ToolmarkAI', 'try toolmark.ai today', 'code at github.com/me/toolmark'];
  const other = ['ATF’s forensic firearm and toolmark examiners', 'Toolmark pilgrammed #pilgrammed', 'DNA/toolmark reports', '#forensic #toolmark practitioners'];
  for (const t of yes) assert.equal(matchQuery(post(t), q, { complete: true }).ok, true, t);
  for (const t of other) assert.deepEqual(matchQuery(post(t), q, { complete: true }), { ok: false, reason: 'spelling' }, t);
  assert.deepEqual(matchQuery(post('Firearms & Tool Mark Identification'), q, { complete: true }), { ok: false, reason: 'missing' });
  assert.equal(spellingOf('nothing here', 'ToolMark'), 'absent');
  // Partial snippets (web pages): only contradicting evidence removes a result.
  assert.equal(matchQuery(post('A page about something else'), q, { complete: false }).ok, true);
  assert.equal(matchQuery(post('toolmark examiners wanted'), q, { complete: false }).ok, false);
});

test('an account named after the query counts as mentioning it; short words do not hide in handles', () => {
  assert.equal(matchQuery(post('We just launched v2!', { handle: 'ToolmarkAI', name: 'ToolMark AI' }), parseQuery('ToolMark'), { complete: true }).ok, true);
  assert.equal(matchQuery(post('Introducing dots, always-on agents', { handle: 'OpenAI', name: 'OpenAI' }), parseQuery('OpenAI Dots'), { complete: true }).ok, true);
  assert.equal(matchQuery(post('new agents are here', { handle: 'dailyai', name: 'Daily' }), parseQuery('AI agents'), { complete: true }).ok, false);
});

test('exclusions and from: apply to every result', () => {
  const q = parseQuery('toolmark -forensic from:me');
  assert.deepEqual(matchQuery(post('toolmark launch', { handle: 'someone' }), q, { complete: true }), { ok: false, reason: 'author' });
  assert.deepEqual(matchQuery(post('toolmark forensics lab', { handle: 'me' }), q, { complete: true }), { ok: false, reason: 'excluded' });
  assert.equal(matchQuery(post('toolmark launch', { handle: 'Me' }), q, { complete: true }).ok, true);
});

function fakeScour(adapters) {
  return new Scour({
    registry: new Registry().register(...adapters),
    cache: new NullCache(),
    config: { cacheDir: '', defaultTtlSec: 0, maxTier: Tier.Headless, maxCostUsd: 0, timeoutMs: 1000, concurrency: 2, userAgent: 't', politenessMs: 0, credentials: {}, providers: {} },
  });
}

test('search hides mismatches before trimming to the limit, and says what it hid', async () => {
  const hits = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...post(`forensic toolmark examiners ${i}`), url: `https://x.com/a/status/${i}` })),
    { ...post('Shipping ToolMark 2.0 today'), url: 'https://x.com/b/status/9' },
  ];
  const x = { name: 'twitter', completeSnippets: true, queryOperators: true, match: () => false, fetch: async () => { throw new Error('no'); }, search: async () => hits };
  const res = await fakeScour([x]).search('ToolMark', { source: 'twitter', limit: 2 });
  assert.deepEqual(res.results.map((r) => r.url), ['https://x.com/b/status/9'], 'the real match further down the list survives');
  assert.match(res.notes.join(' '), /Hid 4 results that spell "ToolMark" differently/);
  assert.match(res.notes.join(' '), /Type "toolmark" in lowercase/);
});

test('search: adapters get plain words unless they understand operators; adapter notes and hints reach the answer', async () => {
  const seen = {};
  const web = { name: 'websearch', match: () => false, fetch: async () => { throw new Error('no'); }, search: async (q) => { seen.web = q; return []; } };
  const x = {
    name: 'twitter', completeSnippets: true, queryOperators: true, match: () => false, fetch: async () => { throw new Error('no'); },
    emptyHint: (q) => (q.from.length ? undefined : 'try from:handle'),
    search: async (q, ctx) => { seen.x = q; ctx.note('X: @me: rate-limited for 3 more min'); return []; },
  };
  const s = fakeScour([web, x]);
  const res = await s.search('ToolMark -forensic from:me', { source: 'websearch,twitter' });
  assert.equal(seen.web, 'ToolMark');
  assert.equal(seen.x, 'ToolMark -forensic from:me');
  assert.deepEqual(res.results, []);
  assert.ok(res.notes.includes('X: @me: rate-limited for 3 more min'), 'route problems are reported, not swallowed');
  assert.ok(!res.notes.includes('try from:handle'), 'no from: hint when from: was used');
  const res2 = await s.search('ToolMark', { source: 'twitter' });
  assert.ok(res2.notes.includes('try from:handle'));
});

test('X profile timeline: parses the embed data, drops reposts, remembers the id, backs off on 429', async () => {
  const { profileTimeline } = await import('../dist/adapters/twitter.js');
  const user = { id_str: '42', screen_name: 'me', name: 'Me', followers_count: 120 };
  const entries = [
    { type: 'tweet', content: { tweet: { id_str: '2', full_text: 'Shipping ToolMark today', created_at: 'Tue Sep 29 17:19:49 +0000 2026', favorite_count: 5, reply_count: 1, user } } },
    { type: 'tweet', content: { tweet: { id_str: '3', full_text: 'RT @other: not mine', created_at: 'Tue Sep 29 18:00:00 +0000 2026', user } } },
  ];
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries } } } })}</script></html>`;
  const store = new Map();
  const cache = { get: async (k) => (store.has(k) ? { value: store.get(k) } : null), set: async (k, v) => { store.set(k, v); } };
  const urls = [];
  let status = 200;
  const ctx = {
    options: { timeoutMs: 1000 }, cache, log: { warn() {}, debug() {} },
    http: { get: async (u) => { urls.push(u); return { status, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 300) }, body: status === 200 ? html : 'Rate limit exceeded' }; } },
  };
  const t = await profileTimeline('@me', ctx);
  assert.deepEqual(t.tweets.map((x) => x.id_str), ['2']);
  assert.equal(t.user.followers_count, 120);
  assert.equal(store.get('x:uid:me'), '42');
  await profileTimeline('me', ctx);
  assert.equal(urls.length, 1, 'second read is cached');

  status = 429;
  store.delete('x:timeline:me');
  await assert.rejects(profileTimeline('me', ctx), /rate-limited for \d+ more min/);
  assert.ok(urls[1].includes('/user-id/42'), 'the by-id route is tried first once the id is known');
  assert.ok(urls[2].includes('/screen-name/me'));
  const before = urls.length;
  await assert.rejects(profileTimeline('me', ctx), /rate-limited/);
  assert.equal(urls.length, before, 'no requests while both routes cool down');
});

test('X archive import: own posts only, long posts in full, links expanded; then searchable', async () => {
  const home = tmp();
  const prev = process.env.SCOUR_HOME;
  process.env.SCOUR_HOME = home;
  try {
    const dir = path.join(home, 'archive', 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'account.js'), 'window.YTD.account.part0 = [{"account":{"username":"me","accountId":"42","accountDisplayName":"Me","email":"secret@example.com"}}]');
    const tweets = [
      { tweet: { id_str: '1', full_text: 'Old post about ToolMark https://t.co/abc', created_at: 'Mon Jan 05 10:00:00 +0000 2026', favorite_count: '12', retweet_count: '3', entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://toolmark.ai' }] } } },
      { tweet: { id_str: '2', full_text: 'RT @other: someone else', created_at: 'Tue Jan 06 10:00:00 +0000 2026', favorite_count: '0', retweet_count: '0' } },
      { tweet: { id_str: '3', full_text: 'A long post that X cut short…', created_at: 'Wed Jan 07 10:00:00 +0000 2026', favorite_count: '1', retweet_count: '0' } },
    ];
    writeFileSync(path.join(dir, 'tweets.js'), `window.YTD.tweets.part0 = ${JSON.stringify(tweets)}`);
    writeFileSync(path.join(dir, 'note-tweet.js'), `window.YTD.note_tweet.part0 = ${JSON.stringify([{ noteTweet: { createdAt: '2026-01-07T10:00:00.000Z', core: { text: 'A long post that X cut short in tweets.js, which ends by mentioning ToolMark again.' } } }])}`);

    const { importXArchive, searchArchives } = await import('../dist/adapters/x-archive.js');
    const { archive, file } = await importXArchive(path.join(home, 'archive'));
    assert.equal(archive.handle, 'me');
    assert.deepEqual(archive.posts.map((p) => p.id), ['3', '1'], 'newest first, reposts dropped');
    assert.match(archive.posts[1].text, /https:\/\/toolmark\.ai/);
    assert.equal(archive.posts[1].likes, 12);
    const { readFileSync, statSync } = await import('node:fs');
    assert.doesNotMatch(readFileSync(file, 'utf-8'), /secret@example\.com/, 'nothing but posts is kept');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const found = await searchArchives(parseQuery('ToolMark'), 10);
    assert.deepEqual(found.map((r) => r.url), ['https://x.com/me/status/3', 'https://x.com/me/status/1'], 'the long post matches on its full text');
    assert.equal((await searchArchives(parseQuery('ToolMark from:someoneelse'), 10)).length, 0);
  } finally {
    if (prev === undefined) delete process.env.SCOUR_HOME; else process.env.SCOUR_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
