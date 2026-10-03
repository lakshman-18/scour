// Offline adapter tests against captured payload shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syndicationToken, tweetId, decodeEntities, xArticleId } from '../dist/adapters/twitter.js';
import { extractVideoId, vttToText } from '../dist/adapters/youtube.js';
import { parseFeed, discoverFeeds } from '../dist/adapters/rss.js';
import { parseCommentFragment } from '../dist/adapters/reddit.js';
import { isDdgChallenge } from '../dist/search/websearch.js';
import { parseNotify, payload, plain } from '../dist/workflows/notify.js';
import { parseLlmsTxt } from '../dist/workflows/map.js';

test('twitter: syndication token is deterministic and in the widget format', () => {
  const t = syndicationToken('1886192184808149383');
  assert.equal(t, syndicationToken('1886192184808149383'));
  assert.match(t, /^[1-9a-z]+$/, 'base-36 with zeros and dots stripped');
  // Adjacent 19-digit ids share one IEEE-754 double, exactly as in the widget,
  // so compare ids that differ in the significant digits.
  assert.notEqual(t, syndicationToken('1700000000000000000'));
});

test('twitter: tweet ids from every URL shape', () => {
  assert.equal(tweetId(new URL('https://x.com/a/status/123')), '123');
  assert.equal(tweetId(new URL('https://twitter.com/a/statuses/456/photo/1')), '456');
  assert.equal(tweetId(new URL('https://x.com/a')), null);
});

test('youtube: video ids from every URL shape', () => {
  assert.equal(extractVideoId(new URL('https://www.youtube.com/watch?v=zjkBMFhNj_g&t=10')), 'zjkBMFhNj_g');
  assert.equal(extractVideoId(new URL('https://youtu.be/zjkBMFhNj_g')), 'zjkBMFhNj_g');
  assert.equal(extractVideoId(new URL('https://www.youtube.com/shorts/abcDEF12345')), 'abcDEF12345');
  assert.equal(extractVideoId(new URL('https://www.youtube.com/embed/abcDEF12345')), 'abcDEF12345');
  assert.equal(extractVideoId(new URL('https://www.youtube.com/@channel')), null);
});

test('youtube: VTT parser drops timings, tags and rolling duplicates', () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000 align:start position:0%
hi<00:00:00.500><c> everyone</c>

00:00:02.000 --> 00:00:02.010
hi everyone

00:00:02.010 --> 00:00:04.000
so today we talk
`;
  assert.equal(vttToText(vtt), 'hi everyone so today we talk');
});

test('rss: RSS 2.0 with content:encoded', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Blog</title><link>https://b.example</link><description>Words</description>
  <item><title>One</title><link>https://b.example/1</link><guid>g1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
  <dc:creator>Ada</dc:creator><category>ai</category><content:encoded><![CDATA[<p>Hello <b>world</b></p>]]></content:encoded></item>
  </channel></rss>`;
  const d = parseFeed(xml, 'https://b.example/feed');
  assert.equal(d.kind, 'listing');
  assert.equal(d.title, 'Blog');
  assert.equal(d.children.length, 1);
  const item = d.children[0];
  assert.equal(item.id, 'rss:g1');
  assert.equal(item.url, 'https://b.example/1');
  assert.equal(item.author.name, 'Ada');
  assert.deepEqual(item.tags, ['ai']);
  assert.equal(item.publishedAt, '2026-09-01T10:00:00.000Z');
  assert.match(item.text, /Hello \*\*world\*\*/);
});

test('rss: Atom and JSON Feed', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><link rel="alternate" href="https://a.example"/>
    <entry><id>e1</id><title>E</title><link rel="alternate" href="https://a.example/e"/><updated>2026-01-01T00:00:00Z</updated><summary>s</summary></entry></feed>`;
  const a = parseFeed(atom, 'https://a.example/atom');
  assert.equal(a.extra.feedType, 'atom');
  assert.equal(a.children[0].url, 'https://a.example/e');

  const jf = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://j.example/1', title: 'T', content_text: 'body' }] });
  const j = parseFeed(jf, 'https://j.example/feed.json');
  assert.equal(j.extra.feedType, 'jsonfeed');
  assert.equal(j.children[0].text, 'body');
});

test('rss: feed discovery from <link rel=alternate>, with conventional fallbacks', () => {
  const found = discoverFeeds('<link rel="alternate" type="application/rss+xml" href="/rss.xml">', 'https://s.example/post');
  assert.deepEqual(found, ['https://s.example/rss.xml']);
  assert.ok(discoverFeeds('<html></html>', 'https://s.example').includes('https://s.example/feed'));
});

test('reddit: comment fragment becomes a tree via parentid, with bodies by thingid', () => {
  const html = `
  <shreddit-comment thingid="t1_a" author="alice" score="10" depth="0" created="2026-10-02T10:00:00.000000+0000" permalink="/r/x/comments/p/comment/a/"></shreddit-comment>
  <div id="t1_a-comment-rtjson-content"><p>top level</p></div>
  <shreddit-comment thingid="t1_b" parentid="t1_a" author="bob" score="3" depth="1" permalink="/r/x/comments/p/comment/b/"></shreddit-comment>
  <div id="t1_b-comment-rtjson-content"><p>a reply</p></div>
  <shreddit-comment thingid="t1_c" author="carol" score="1" depth="0" permalink="/r/x/comments/p/comment/c/"></shreddit-comment>
  <div id="t1_c-comment-rtjson-content"><p>second root</p></div>`;
  const roots = parseCommentFragment(html);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].author.handle, 'alice');
  assert.equal(roots[0].text, 'top level');
  assert.equal(roots[0].engagement.score, 10);
  assert.equal(roots[0].children[0].author.handle, 'bob');
  assert.equal(roots[0].children[0].text, 'a reply');
  assert.equal(roots[1].text, 'second root');
});

test('websearch: a DuckDuckGo CAPTCHA is recognised (so we back off instead of parsing junk)', () => {
  assert.equal(isDdgChallenge(202, ''), true);
  assert.equal(isDdgChallenge(200, '<p>Unfortunately, bots use DuckDuckGo too.</p>'), true);
  assert.equal(isDdgChallenge(200, '<a class="result-link" href="https://x">x</a>'), false);
});

test('twitter: HTML entities in tweet text are decoded (&amp; last, so "&amp;gt;" stays literal)', () => {
  assert.equal(decodeEntities('a &gt; b &amp; c &#39;d&#39; &amp;gt;'), "a > b & c 'd' &gt;");
});

test('notify: specs parse, secrets are redacted, http is refused for chat webhooks', () => {
  assert.equal(parseNotify('ntfy:my-topic').target, 'https://ntfy.sh/my-topic');
  assert.equal(parseNotify('macos').kind, 'macos');
  assert.equal(parseNotify('https://hooks.example/x/SECRET').kind, 'webhook');
  assert.doesNotMatch(parseNotify('slack:https://hooks.slack.com/services/T/B/SECRET').target, /SECRET/);
  assert.equal(parseNotify('telegram:-100123@123:ABC').target, 'chat -100123');
  assert.throws(() => parseNotify('slack:http://insecure.example/x'), /https/);
  assert.throws(() => parseNotify('pager:whatever'), /Unknown notify target/);
});

test('notify: payload and chat text summarise new items', () => {
  const r = {
    url: 'https://feed.example/rss', label: 'Feed', changed: true, kind: 'new-items', checkedAt: '2026-10-02T00:00:00Z',
    newItems: [{ id: 'rss:1', url: 'https://feed.example/1', title: 'First post', source: 'rss', kind: 'article', text: '' }],
    document: {},
  };
  const p = payload(r);
  assert.equal(p.event, 'scour.watch.changed');
  assert.equal(p.summary, 'Feed: 1 new item');
  assert.equal(p.newItems[0].title, 'First post');
  assert.match(plain(r, 'slack'), /<https:\/\/feed\.example\/1\|First post>/);
});

test('map: llms.txt links are parsed and resolved against the origin', () => {
  const links = parseLlmsTxt('# Docs\n- [Intro](/intro.md): start here\n- [API](https://d.example/api.md)', 'https://d.example');
  assert.deepEqual(links.map((l) => l.url), ['https://d.example/intro.md', 'https://d.example/api.md']);
  assert.equal(links[0].title, 'Intro');
});

test('websearch: site: operators become domain filters for APIs that need them', async () => {
  const { splitSiteOperators } = await import('../dist/search/websearch.js');
  assert.deepEqual(splitSiteOperators('site:x.com OpenAI dots'), { query: 'OpenAI dots', domains: ['x.com'] });
  assert.deepEqual(splitSiteOperators('rust site:https://github.com/rust-lang async'), { query: 'rust async', domains: ['github.com'] });
  assert.deepEqual(splitSiteOperators('no operators'), { query: 'no operators', domains: [] });
});

test('twitter: X Article ids from both URL shapes, and they route to the X adapter', async () => {
  assert.equal(xArticleId(new URL('https://x.com/i/article/2105277060478382207')), '2105277060478382207');
  assert.equal(xArticleId(new URL('https://x.com/monokern/article/2105277060478382207')), '2105277060478382207');
  assert.equal(xArticleId(new URL('https://x.com/monokern/status/2105277060478382207')), null);
  const { defaultRegistry } = await import('../dist/index.js');
  assert.equal(defaultRegistry().resolve(new URL('https://x.com/i/article/1')).name, 'twitter');
});

test('images: X media URLs are requested at a viewable size; other URLs pass through', async () => {
  const { viewableUrl } = await import('../dist/core/images.js');
  assert.equal(viewableUrl('https://pbs.twimg.com/media/HTjGOuZbwAAwUCA.jpg'), 'https://pbs.twimg.com/media/HTjGOuZbwAAwUCA?format=jpg&name=medium');
  assert.equal(viewableUrl('https://example.com/a.png'), 'https://example.com/a.png');
});

test('arxiv: ids from abs, pdf and versioned URLs', async () => {
  const { arxivId } = await import('../dist/adapters/arxiv.js');
  assert.equal(arxivId(new URL('https://arxiv.org/abs/1706.03762')), '1706.03762');
  assert.equal(arxivId(new URL('https://arxiv.org/pdf/1706.03762v7')), '1706.03762');
  assert.equal(arxivId(new URL('https://arxiv.org/pdf/2401.00001.pdf')), '2401.00001');
  assert.equal(arxivId(new URL('https://arxiv.org/abs/hep-th/9901001')), 'hep-th/9901001');
});
