// Offline, deterministic tests. No network: these must pass on a plane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalUrl, normaliseUrl, Scour, isRelevant } from '../dist/core/pipeline.js';
import { Registry } from '../dist/core/registry.js';
import { Ledger } from '../dist/core/budget.js';
import { FileCache, NullCache } from '../dist/core/cache.js';
import { extractFromHtml, clip, normDate, cleanServedMarkdown } from '../dist/core/extract.js';
import { Tier, TierError, BudgetExceeded } from '../dist/core/types.js';
import { defaultRegistry } from '../dist/index.js';
import { parseRobots, robotsAllows, parseSitemap } from '../dist/workflows/crawl.js';
import { lineDiff } from '../dist/workflows/watch.js';
import { pooledMap } from '../dist/workflows/pool.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'scour-test-'));

// ---------------------------------------------------------------- URLs
test('canonicalUrl strips tracking params, fragment and trailing slash; sorts query', () => {
  const u = new URL('https://Example.com/a/b/?utm_source=x&b=2&fbclid=y&a=1#frag');
  assert.equal(canonicalUrl(u), 'https://example.com/a/b?a=1&b=2');
});

test('normaliseUrl accepts bare hosts and rejects junk', () => {
  assert.equal(normaliseUrl('example.com/x').href, 'https://example.com/x');
  assert.throws(() => normaliseUrl('not a url at all'), /Not a usable URL/);
});

// ---------------------------------------------------------------- registry
test('registry routes each platform to its adapter and everything else to web', () => {
  const r = defaultRegistry();
  const cases = {
    'https://www.reddit.com/r/x/comments/abc/t/': 'reddit',
    'https://news.ycombinator.com/item?id=1': 'hn',
    'https://github.com/a/b': 'github',
    'https://youtu.be/abcdefghijk': 'youtube',
    'https://x.com/a/status/123': 'twitter',
    'https://twitter.com/a/status/123': 'twitter',
    'https://en.wikipedia.org/wiki/X': 'wikipedia',
    'https://stackoverflow.com/questions/1/x': 'stackoverflow',
    'https://example.com/feed.xml': 'rss',
    'https://some-random-blog.dev/post': 'web',
  };
  for (const [url, want] of Object.entries(cases)) assert.equal(r.resolve(new URL(url)).name, want, url);
});

test('websearch never claims a URL for fetching', () => {
  const r = defaultRegistry();
  assert.equal(r.byName('websearch').match(new URL('https://duckduckgo.com')), false);
});

// ---------------------------------------------------------------- budget
test('ledger: free calls never touch it; paid calls are refused past the cap', () => {
  const l = new Ledger(0.002);
  l.charge(0, 'free');
  assert.equal(l.entries.length, 0);
  l.charge(0.001, 'a');
  l.charge(0.001, 'b');
  assert.throws(() => l.charge(0.0001, 'c'), BudgetExceeded);
  assert.equal(l.spentUsd, 0.002);
});

test('default $0 cap makes any paid call impossible', () => {
  assert.throws(() => new Ledger(0).charge(0.0002, 'jina'), /Budget exceeded/);
});

// ---------------------------------------------------------------- cache
test('file cache: round-trip, TTL expiry, stale read, prune', async () => {
  const dir = tmp();
  try {
    const c = new FileCache(dir);
    await c.set('k', { a: 1 }, 60, { etag: 'W/"1"' });
    assert.deepEqual((await c.get('k')).value, { a: 1 });
    assert.equal((await c.get('k')).etag, 'W/"1"');
    await c.set('old', 'x', -1);
    assert.equal(await c.get('old'), null, 'expired entries are misses');
    assert.equal((await c.getStale('old')).value, 'x', 'but still readable for revalidation');
    assert.equal(await c.prune(), 1);
    assert.equal((await c.stats()).entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache hash is stable across key order', async () => {
  const dir = tmp();
  try {
    const c = new FileCache(dir);
    await c.set('a', { x: 1, y: 2 }, 60);
    await c.set('b', { y: 2, x: 1 }, 60);
    assert.equal((await c.get('a')).hash, (await c.get('b')).hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- extraction
const ARTICLE = `<!doctype html><html lang="en"><head>
<title>Fallback title</title>
<meta property="og:title" content="The Real Title">
<meta property="og:description" content="A short summary.">
<meta property="article:published_time" content="2026-01-02T03:04:05Z">
<script type="application/ld+json">{"@type":"BlogPosting","author":{"name":"Ada Lovelace"}}</script>
</head><body>
<nav>Home | About | Login</nav>
<article>
<h1>The Real Title</h1>
${'<p>Analytical engines weave algebraic patterns just as the Jacquard loom weaves flowers and leaves. '.repeat(6)}</p>
<pre><code class="language-python">print("hello")</code></pre>
<table><tr><th>Engine</th><th>Year</th></tr><tr><td>Difference</td><td>1822</td></tr></table>
<p>See <a href="/notes">the notes</a> and <a href="https://other.example/x">elsewhere</a>.</p>
</article>
<footer>© 2026 Cookie banner nonsense</footer>
</body></html>`;

test('extract: readability body, metadata from OG + JSON-LD, code fences, tables, links', () => {
  const ex = extractFromHtml(ARTICLE, 'https://blog.example/post');
  assert.equal(ex.method, 'readability');
  assert.equal(ex.title, 'The Real Title');
  assert.equal(ex.excerpt, 'A short summary.');
  assert.equal(ex.author.name, 'Ada Lovelace');
  assert.equal(ex.publishedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(ex.lang, 'en');
  assert.match(ex.text, /```python\nprint\("hello"\)\n```/);
  assert.match(ex.text, /\| Engine \| Year \|\n\| --- \| --- \|\n\| Difference \| 1822 \|/);
  assert.match(ex.text, /\[the notes\]\(https:\/\/blog\.example\/notes\)/, 'links in the body must be absolute');
  assert.doesNotMatch(ex.text, /Cookie banner/);
  const notes = ex.links.find((l) => l.url === 'https://blog.example/notes');
  assert.ok(notes && notes.external === false);
  assert.equal(ex.links.find((l) => l.url.startsWith('https://other.example')).external, true);
});

test('extract: explicit selector wins and missing selector errors clearly', () => {
  const ex = extractFromHtml(ARTICLE, 'https://blog.example/post', { selector: 'table' });
  assert.equal(ex.method, 'selector');
  assert.match(ex.text, /Difference/);
  assert.throws(() => extractFromHtml(ARTICLE, 'https://b.example', { selector: '#nope' }), /matched nothing/);
});

test('clip cuts on a paragraph boundary and says so', () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} `.repeat(10)).join('\n\n');
  const out = clip(text, 100);
  assert.ok(out.length < text.length);
  assert.match(out, /clipped to ~100 tokens/);
});

test('normDate handles epoch seconds, epoch ms and ISO strings', () => {
  assert.equal(normDate(1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(normDate('1700000000000'), '2023-11-14T22:13:20.000Z');
  assert.equal(normDate('2024-02-29'), '2024-02-29T00:00:00.000Z');
  assert.equal(normDate('garbage'), undefined);
});

// ---------------------------------------------------------------- crawl helpers
test('robots: longest match wins, ties go to allow, only the * group counts', () => {
  const r = parseRobots(`User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/public\n`);
  assert.equal(robotsAllows(r, '/blog'), true);
  assert.equal(robotsAllows(r, '/private/x'), false);
  assert.equal(robotsAllows(r, '/private/public/y'), true);
});

test('sitemap parser reads <loc>, even through a code fence', () => {
  const xml = '```xml\n<urlset><url><loc>https://a.example/1</loc></url><url><loc> https://a.example/2 </loc></url></urlset>\n```';
  assert.deepEqual(parseSitemap(xml), ['https://a.example/1', 'https://a.example/2']);
});

// ---------------------------------------------------------------- watch
test('lineDiff reports added and removed lines only', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd');
  assert.match(d, /^- b$/m);
  assert.match(d, /^\+ d$/m);
  assert.doesNotMatch(d, /^[-+] a$/m);
});

// ---------------------------------------------------------------- pool
test('pooledMap respects the concurrency limit and never rejects', async () => {
  let live = 0;
  let peak = 0;
  const res = await pooledMap([1, 2, 3, 4, 5, 6], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    if (n === 4) throw new Error('boom');
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.equal(res.filter((r) => r.ok).length, 5);
  assert.equal(res[3].ok, false);
  assert.equal(res[3].error.message, 'boom');
});

// ---------------------------------------------------------------- pipeline
function fakeScour(adapters, { cache = new NullCache(), maxCostUsd = 0, maxTier = Tier.Headless } = {}) {
  const registry = new Registry().register(...adapters);
  return new Scour({
    registry,
    cache,
    config: {
      cacheDir: '', defaultTtlSec: 60, maxTier, maxCostUsd, timeoutMs: 1000, concurrency: 2,
      userAgent: 'test', politenessMs: 0, credentials: {}, providers: {},
    },
  });
}

const doc = (source, url, text = 'hello') => ({
  id: `${source}:1`, url, source, kind: 'article', text,
  provenance: { tier: Tier.Native, tierName: 'native', adapter: source, strategy: 's', finalUrl: url, elapsedMs: 0, costUsd: 0, bytes: 0, cached: false, fetchedAt: '' },
});

test('pipeline: second identical get is a tier-0 cache hit', async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const a = { name: 'web', priority: -100, match: () => true, fetch: async (u) => { calls++; return doc('web', u.href); } };
    const s = fakeScour([a], { cache: new FileCache(dir) });
    const first = await s.get('https://a.example/x?utm_source=nope');
    const second = await s.get('https://a.example/x');
    assert.equal(calls, 1, 'tracking params must not cause a cache miss');
    assert.equal(first.provenance.cached, false);
    assert.equal(second.provenance.cached, true);
    assert.equal(second.provenance.tierName, 'cache');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline: a failing platform adapter falls back to generic web and records the attempt', async () => {
  const broken = { name: 'site', priority: 50, match: (u) => u.hostname === 'site.example', fetch: async () => { throw new TierError('blocked', Tier.Native); } };
  const web = { name: 'web', priority: -100, match: () => true, fetch: async (u) => doc('web', u.href, 'rescued') };
  const d = await fakeScour([broken, web]).get('https://site.example/p');
  assert.equal(d.text, 'rescued');
  assert.equal(d.provenance.attempts.length, 1);
  assert.equal(d.provenance.attempts[0].strategy, 'site');
});

test('pipeline: budget refusals are never silently rescued by a fallback', async () => {
  const spendy = { name: 'site', priority: 50, match: () => true, fetch: async (_u, ctx) => { ctx.budget.charge(0.01, 'pricey'); return doc('site', 'x'); } };
  const web = { name: 'web', priority: -100, match: () => true, fetch: async (u) => doc('web', u.href) };
  await assert.rejects(fakeScour([spendy, web]).get('https://any.example'), BudgetExceeded);
});

test('pipeline: per-document cost is metered separately from the session total', async () => {
  const paid = { name: 'web', priority: -100, match: () => true, fetch: async (u, ctx) => { ctx.budget.charge(0.001, 'p'); return doc('web', u.href); } };
  const s = fakeScour([paid], { maxCostUsd: 1, maxTier: Tier.Paid });
  const a = await s.get('https://a.example/1');
  const b = await s.get('https://a.example/2');
  assert.equal(a.provenance.costUsd, 0.001);
  assert.equal(b.provenance.costUsd, 0.001);
  assert.equal(s.budget.spentUsd, 0.002);
});

test('pipeline: render() refuses when the tier ceiling is below headless', async () => {
  const needsBrowser = { name: 'web', priority: -100, match: () => true, fetch: async (u, ctx) => { await ctx.render(u.href); return doc('web', u.href); } };
  await assert.rejects(fakeScour([needsBrowser], { maxTier: Tier.Static }).get('https://spa.example'), /needs the headless tier/);
});

test('extract: when Readability keeps only headings, fall back to the main region', () => {
  const sections = ['Overview', 'Getting started', 'Memory', 'Controls'];
  const body = sections.map((h) => `<h2>${h}</h2><div class="x"><span>${`${h} explained in detail with plenty of real sentences. `.repeat(12)}</span></div>`).join('');
  const html = `<html><body><nav>Home Docs</nav><main><h1>Getting started</h1>${body}</main></body></html>`;
  const ex = extractFromHtml(html, 'https://help.example/a');
  assert.ok(ex.text.length > 2000, `expected the body text, got ${ex.text.length} chars`);
  assert.match(ex.text, /Memory explained in detail/);
});

test('fan-out relevance: keeps on-topic hits, drops single-keyword noise', () => {
  const q = 'OpenAI Dots';
  assert.equal(isRelevant({ title: 'Introducing dots, always-on agents', url: 'https://youtube.com/x', source: 'youtube', author: { name: 'OpenAI' } }, q), true);
  assert.equal(isRelevant({ title: 'OpenAI launches dots (long-running agents)', url: 'https://reddit.com/x', source: 'reddit' }, q), true);
  assert.equal(isRelevant({ title: 'Deployed app services receive values with comma instead of dots', url: 'https://stackoverflow.com/q/1', source: 'stackoverflow' }, q), false);
  assert.equal(isRelevant({ title: 'Sam Altman', url: 'https://en.wikipedia.org/wiki/Sam_Altman', source: 'wikipedia' }, q), false);
  assert.equal(isRelevant({ title: 'anything', url: 'https://x', source: 'web' }, 'rust'), true, 'single-term queries are not filtered');
});

test('served markdown: link farms, raw HTML widgets and JSON-LD are removed; JSON-LD becomes metadata', () => {
  const md = [
    '[Home](https://s.example/) [Blog](https://s.example/b) [Docs](https://s.example/d) [Login](https://s.example/l)',
    '# Real title',
    'Real paragraph with an [inline link](https://s.example/x) that must survive.',
    '<details>', '<summary>Languages</summary>', '- <a href="/de">Deutsch</a>', '</details>',
    '```json', '{"@context":"https://schema.org","@type":"BlogPosting","datePublished":"2026-02-12T14:03:00.000Z","author":{"name":"Ada"}}', '```',
  ].join('\n');
  const out = cleanServedMarkdown(md);
  assert.doesNotMatch(out.text, /\[Login\]/);
  assert.doesNotMatch(out.text, /Deutsch|@context/);
  assert.match(out.text, /inline link/);
  assert.equal(out.jsonLd.datePublished, '2026-02-12T14:03:00.000Z');
  assert.equal(out.jsonLd.author, 'Ada');
});

test('usage: free allowance costs $0, the first billable unit is priced, and it persists per month', async () => {
  const home = tmp();
  const prev = process.env.SCOUR_HOME;
  process.env.SCOUR_HOME = home;
  try {
    const { costOf, recordUsage, usedThisMonth } = await import('../dist/core/usage.js');
    assert.equal(await costOf('brave', 1), 0, 'inside the allowance');
    await recordUsage('brave', 949);
    assert.equal(await costOf('brave', 1), 0, 'unit 950 is still free');
    assert.equal(await costOf('brave', 2), 0.005, 'unit 951 is billed');
    await recordUsage('brave', 1);
    assert.equal(await usedThisMonth('brave'), 950);
    assert.equal(await costOf('brave', 1), 0.005);
    assert.equal(await costOf('x-api-posts', 100), 0.5, 'X API has no free allowance');
    assert.equal(await costOf('unknown-provider', 5), 0);
  } finally {
    if (prev === undefined) delete process.env.SCOUR_HOME; else process.env.SCOUR_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('tidy collapses nested-bold ****text**** into **text**', async () => {
  const { tidy } = await import('../dist/core/extract.js');
  assert.equal(tidy('****Bold point:**** rest and ****more****'), '**Bold point:** rest and **more**');
  assert.equal(tidy('**normal** stays'), '**normal** stays');
});
