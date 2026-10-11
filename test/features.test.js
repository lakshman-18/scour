// Offline: files → Markdown, focus, page actions, learn-by-example with repair,
// X thread/reply parsing, saved-login lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { convertDocument, documentFormat, parseDelimited } from '../dist/core/documents.js';
import { focusMarkdown } from '../dist/core/focus.js';
import { parseAction, actionsFromFirecrawl } from '../dist/core/actions.js';
import { learnFromHtml, applyRule } from '../dist/workflows/learn.js';
import { parseThreadReader } from '../dist/adapters/x-conversation.js';
import { postsFromGraphql } from '../dist/adapters/x-graphql.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'scour-f-'));

test('documentFormat: by content type or extension', () => {
  assert.equal(documentFormat('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'x'), 'pptx');
  assert.equal(documentFormat('', 'https://a/b/report.xlsx?dl=1'), 'xlsx');
  assert.equal(documentFormat('application/epub+zip', 'x'), 'epub');
  assert.equal(documentFormat('text/csv; charset=utf-8', 'x'), 'csv');
  assert.equal(documentFormat('text/html', 'https://a/'), null);
});

test('CSV: quotes, embedded commas and newlines become a Markdown table', async () => {
  assert.deepEqual(parseDelimited('a,b\n"x, y","line1\nline2"\n', ','), [['a', 'b'], ['x, y', 'line1\nline2']]);
  const d = await convertDocument(Buffer.from('name,price\nWidget,"$1,200"\n'), 'csv');
  assert.match(d.text, /\| name \| price \|/);
  assert.match(d.text, /\| Widget \| \$1,200 \|/);
});

test('PowerPoint: title, bullets, table, image alt text and speaker notes', async () => {
  const slide = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Ship scour</a:t></a:r></a:p><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>Docs &amp; tests</a:t></a:r></a:p></p:txBody></p:sp>
    <p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Goal</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q4</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>1k users</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>
    <p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic" descr="Growth chart"/></p:nvPicPr></p:pic>
  </p:spTree></p:cSld></p:sld>`;
  const rels = `<Relationships><Relationship Id="rId2" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;
  const notes = `<p:notes xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say it slowly</a:t></a:r></a:p></p:txBody></p:sp></p:notes>`;
  const zip = zipSync({
    'ppt/slides/slide1.xml': strToU8(slide),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(rels),
    'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
    'docProps/core.xml': strToU8('<cp><dc:title>Plan deck</dc:title><dc:creator>Lakshman</dc:creator></cp>'),
  });
  const d = await convertDocument(Buffer.from(zip), 'pptx');
  assert.equal(d.title, 'Plan deck');
  assert.equal(d.author, 'Lakshman');
  assert.match(d.text, /## Slide 1: Quarterly plan/);
  assert.match(d.text, /- Ship scour\n {2}- Docs & tests/);
  assert.match(d.text, /\| Q \| Goal \|\n\| --- \| --- \|\n\| Q4 \| 1k users \|/);
  assert.match(d.text, /\[image: Growth chart\]/);
  assert.match(d.text, /\*\*Notes:\*\* Say it slowly/);
});

test('Excel: shared strings, inline strings, booleans, sparse cells, every sheet', async () => {
  const zip = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>Item</t></si><si><t>Qty</t></si><si><r><t>Wid</t></r><r><t>get</t></r></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Paid</t></is></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Gadget</t></is></c><c r="B3"><v>7</v></c></row>
    </sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData/></worksheet>'),
  });
  const d = await convertDocument(Buffer.from(zip), 'xlsx');
  assert.match(d.text, /## Sales/);
  assert.match(d.text, /\| Item \| Qty \| Paid \|/);
  assert.match(d.text, /\| Widget \|  \| TRUE \|/, 'empty cells keep their column');
  assert.match(d.text, /\| Gadget \| 7 \|  \|/);
  assert.doesNotMatch(d.text, /## Empty/);
});

test('local files: documents read; hidden folders and non-documents refused when restricted', async () => {
  const dir = tmp();
  try {
    const { readLocalFile, isLocalFile } = await import('../dist/core/files.js');
    const csv = path.join(dir, 'prices.csv');
    writeFileSync(csv, 'a,b\n1,2\n');
    const d = await readLocalFile(csv, { restrict: true });
    assert.equal(d.source, 'file');
    assert.match(d.text, /\| a \| b \|/);
    assert.equal(await isLocalFile(csv), true);
    assert.equal(await isLocalFile('https://example.com/a.csv'), false);
    assert.equal(await isLocalFile('example.com'), false);
    mkdirSync(path.join(dir, '.secret'));
    writeFileSync(path.join(dir, '.secret', 'notes.txt'), 'x');
    await assert.rejects(readLocalFile(path.join(dir, '.secret', 'notes.txt'), { restrict: true }), /hidden folders/);
    writeFileSync(path.join(dir, 'id_rsa'), 'x');
    await assert.rejects(readLocalFile(path.join(dir, 'id_rsa'), { restrict: true }), /Only documents/);
    assert.match((await readLocalFile(path.join(dir, 'id_rsa'))).text, /x/, 'the CLI (unrestricted) reads any file you name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus: keeps the blocks about the question, under their headings, in order', () => {
  const md = [
    '# Product docs', 'Welcome to the docs. This page covers many topics.',
    '## Installation', 'Run npm install to get started with the package.',
    '## Rate limits', 'Each API key is limited to 60 requests per minute. Exceeding the rate limit returns HTTP 429.',
    'Limits reset every minute; the Retry-After header says when.',
    '## Billing', 'Invoices are sent monthly to the account owner.',
    '## Support', 'Email us any time.',
  ].join('\n\n');
  const f = focusMarkdown(md, 'what are the rate limits?');
  assert.ok(f.kept >= 1 && f.kept < f.total, `${f.kept}/${f.total}`);
  assert.match(f.text, /## Rate limits\n\nEach API key is limited/);
  assert.doesNotMatch(f.text, /Invoices are sent/);
  assert.equal(focusMarkdown(md, 'kubernetes helm charts').kept, 0, 'no match leaves the page alone');
});

test('page actions: command-line steps and Firecrawl objects', () => {
  assert.deepEqual(parseAction('wait:1500'), { type: 'wait', milliseconds: 1500 });
  assert.deepEqual(parseAction('wait:#results'), { type: 'wait', selector: '#results' });
  assert.deepEqual(parseAction('click-all:.expand'), { type: 'click', selector: '.expand', all: true });
  assert.deepEqual(parseAction('write:#q=hello world'), { type: 'write', selector: '#q', text: 'hello world' });
  assert.deepEqual(parseAction('write:a=b c'), { type: 'write', selector: 'a', text: 'b c' });
  assert.deepEqual(parseAction('write:just text'), { type: 'write', text: 'just text' });
  assert.deepEqual(parseAction('press:Enter'), { type: 'press', key: 'Enter' });
  assert.deepEqual(parseAction('screenshot:full'), { type: 'screenshot', fullPage: true });
  assert.throws(() => parseAction('dance:now'), /Unknown action/);
  assert.deepEqual(actionsFromFirecrawl([{ type: 'click', selector: '#a' }, { type: 'wait', milliseconds: 500 }]).map((a) => a.type), ['click', 'wait']);
  assert.throws(() => actionsFromFirecrawl([{ type: 'click' }]), /click.selector is required/);
});

const shop = (cls) => `<html><body><h1>Shop</h1><ul class="${cls.list}">
  ${['Red mug|$12', 'Blue mug|$14', 'Green mug|$9'].map((x) => {
    const [t, p] = x.split('|');
    return `<li class="${cls.item}"><span class="rank">1</span><h3 class="${cls.title}"><a href="/p/${t.split(' ')[0].toLowerCase()}">${t}</a></h3><span class="${cls.price}">${p}</span></li>`;
  }).join('')}</ul></body></html>`;

test('learn by example: one example finds every similar item; several fields line up per item', () => {
  const html = shop({ list: 'products', item: 'product', title: 'name', price: 'price' });
  const one = learnFromHtml(html, 'https://shop.example/', ['Blue mug']);
  assert.deepEqual(one.records.map((r) => r.value), ['Red mug', 'Blue mug', 'Green mug']);
  const two = learnFromHtml(html, 'https://shop.example/', ['title=Red mug', 'price=$12', 'link=https://shop.example/p/blue']);
  assert.deepEqual(two.records, [
    { title: 'Red mug', price: '$12', link: 'https://shop.example/p/red' },
    { title: 'Blue mug', price: '$14', link: 'https://shop.example/p/blue' },
    { title: 'Green mug', price: '$9', link: 'https://shop.example/p/green' },
  ]);
  assert.deepEqual(learnFromHtml(html, 'https://shop.example/', ['Purple mug']).missing, ['Purple mug']);
});

test('saved rules repair themselves when the site renames its classes', () => {
  const before = shop({ list: 'products', item: 'product', title: 'name', price: 'price' });
  const { rule } = learnFromHtml(before, 'https://shop.example/', ['title=Red mug', 'price=$12']);
  const after = shop({ list: 'catalog', item: 'card', title: 'name', price: 'cost' });
  const r = applyRule(after, 'https://shop.example/', rule);
  assert.ok(r.repaired, 'the old selectors found nothing, so the rule was repaired');
  assert.deepEqual(r.records.map((x) => x.title), ['Red mug', 'Blue mug', 'Green mug']);
  assert.deepEqual(r.records.map((x) => x.price), ['$12', '$14', '$9']);
  assert.equal(applyRule(before, 'https://shop.example/', rule).repaired, undefined, 'a working rule is left alone');
});

test('Thread Reader App: the author’s thread, de-duplicated, with links kept', () => {
  const block = (id, who, html) => `<div class="content-tweet" data-screenname="${who}" data-tweet="${id}">${html}<sup class="tw-permalink">#</sup></div>`;
  const html = [
    block('1', 'me', '10 repos you need'),
    block('2', 'me', '<span class="nop">1. </span><br><br>MarkItDown converts files.<a class="entity-url" href="https://github.com/microsoft/markitdown">github.com/micro…</a>'),
    block('2', 'me', 'duplicate copy'),
    block('3', 'someone', 'not the author'),
  ].join('');
  const posts = parseThreadReader(html, '1', 'me');
  assert.deepEqual(posts.map((p) => p.id), ['2']);
  assert.match(posts[0].text, /^1\.\s+MarkItDown converts files\. https:\/\/github\.com\/microsoft\/markitdown$/);
  assert.deepEqual(posts[0].links, ['https://github.com/microsoft/markitdown']);
});

test('X page data: posts found wherever X puts them, long text, views, reposts flagged', () => {
  const user = (h) => ({ result: { rest_id: '9', core: { screen_name: h, name: h.toUpperCase() }, legacy: { followers_count: 50 }, is_blue_verified: true } });
  const tweet = (id, h, text, extra = {}) => ({
    __typename: 'Tweet', rest_id: id, core: { user_results: user(h) }, views: { count: '1200' },
    legacy: { full_text: text, created_at: 'Wed Oct 07 10:00:00 +0000 2026', favorite_count: 5, reply_count: 1, retweet_count: 2, quote_count: 0, conversation_id_str: '1', entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://scour.dev' }] }, ...extra },
  });
  const json = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: tweet('1', 'me', 'Root post https://t.co/x') } } } },
    { content: { items: [{ item: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: { ...tweet('2', 'you', 'short', { in_reply_to_status_id_str: '1' }), note_tweet: { note_tweet_results: { result: { text: 'The full long reply' } } } } } } } } }] } },
    { content: { itemContent: { tweet_results: { result: tweet('3', 'me', 'RT @x: copied') } } } },
  ] }] } } };
  const posts = postsFromGraphql(json);
  assert.deepEqual(posts.map((p) => p.id), ['1', '2', '3']);
  assert.equal(posts[0].text, 'Root post https://scour.dev');
  assert.equal(posts[0].views, 1200);
  assert.equal(posts[0].author.followers, 50);
  assert.equal(posts[1].text, 'The full long reply');
  assert.equal(posts[1].replyToId, '1');
  assert.equal(posts[2].isRepost, true);
});

test('saved logins: site names, aliases and domains map to the right session', async () => {
  const home = tmp();
  const prev = process.env.SCOUR_HOME;
  process.env.SCOUR_HOME = home;
  try {
    const { siteFor, sessionDir, writeMeta, sessionForHost, removeSession } = await import('../dist/render/sessions.js');
    assert.equal(siteFor('twitter').key, 'x');
    assert.equal(siteFor('https://www.linkedin.com/feed').key, 'linkedin');
    assert.equal(siteFor('news.example.com').key, 'news.example.com');
    assert.throws(() => siteFor('not a site'), /not a site/);
    mkdirSync(sessionDir('news.example.com'), { recursive: true });
    await writeMeta('news.example.com', { site: 'news.example.com', savedAt: '2026-10-11T00:00:00Z', loggedIn: true });
    assert.equal((await sessionForHost('a.news.example.com'))?.key, 'news.example.com');
    assert.equal(await sessionForHost('example.com'), null);
    assert.equal(await removeSession('news.example.com'), true);
    assert.equal(await sessionForHost('news.example.com'), null);
  } finally {
    if (prev === undefined) delete process.env.SCOUR_HOME; else process.env.SCOUR_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('AutoThrottle: a 429 slows the host down, honouring Retry-After; normal answers speed it up again', async () => {
  const { HostThrottle } = await import('../dist/core/http.js');
  const t = new HostThrottle(250);
  assert.equal(t.delayFor('a.com'), 250);
  t.penalize('a.com');
  assert.equal(t.delayFor('a.com'), 1250);
  t.penalize('a.com', 5000);
  assert.equal(t.delayFor('a.com'), 5250, 'Retry-After wins when it asks for longer');
  t.penalize('a.com', 120_000);
  assert.equal(t.delayFor('a.com'), 30_250, 'capped at 30 s extra');
  assert.equal(t.delayFor('b.com'), 250, 'other hosts are unaffected');
  for (let i = 0; i < 20; i++) t.relax('a.com');
  assert.equal(t.delayFor('a.com'), 250);
});

test('crawl --state: an interrupted crawl resumes without re-reading finished pages', async () => {
  const dir = tmp();
  try {
    const { crawl } = await import('../dist/workflows/crawl.js');
    const { Scour } = await import('../dist/core/pipeline.js');
    const { Registry } = await import('../dist/core/registry.js');
    const { NullCache } = await import('../dist/core/cache.js');
    const { Tier } = await import('../dist/core/types.js');
    const reads = [];
    const site = {
      name: 'web', priority: -100, match: () => true,
      fetch: async (u) => {
        reads.push(u.pathname);
        const n = Number(u.pathname.slice(3) || 0);
        return { id: u.href, url: u.href, source: 'web', kind: 'article', text: 'x', links: [1, 2].map((k) => ({ url: `https://site.test/p/${n * 2 + k}` })),
          provenance: { tier: Tier.Static, tierName: 'static', adapter: 'web', strategy: 's', finalUrl: u.href, elapsedMs: 0, costUsd: 0, bytes: 0, cached: false, fetchedAt: '' } };
      },
    };
    const scour = new Scour({ registry: new Registry().register(site), cache: new NullCache(),
      config: { cacheDir: '', defaultTtlSec: 0, maxTier: Tier.Headless, maxCostUsd: 0, timeoutMs: 1000, concurrency: 1, userAgent: 't', politenessMs: 0, credentials: {}, providers: {} } });
    const statePath = path.join(dir, 'crawl.json');
    const opts = { depth: 5, useSitemap: false, respectRobots: false, statePath, concurrency: 1 };
    const first = await crawl(scour, 'https://site.test/p/0', { ...opts, limit: 3 });
    assert.equal(first.documents.length, 3);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(statePath), false, 'reaching the limit finishes the crawl and clears the state');

    // Interrupt: a page that throws mid-crawl stops this run with state saved after the first batch.
    reads.length = 0;
    const second = await crawl(scour, 'https://site.test/p/0', { ...opts, limit: 7, onPage: (_d, _depth) => { if (reads.length === 3) throw new Error('interrupted'); } }).catch((e) => e);
    assert.ok(second instanceof Error);
    assert.ok(existsSync(statePath), 'progress was saved');
    reads.length = 0;
    const resumed = await crawl(scour, 'https://site.test/p/0', { ...opts, limit: 7 });
    assert.ok(!reads.includes('/p/0'), 'the seed is not read again');
    assert.equal(existsSync(statePath), false);
    assert.ok(resumed.documents.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
