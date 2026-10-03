// Live canary: hits the real internet. Run it on a schedule and it tells you
// which platform route broke before your agent finds out the hard way.
//   npm run smoke            all checks
//   npm run smoke -- reddit  only names containing "reddit"
import { createScour } from '../dist/index.js';
import { NullCache } from '../dist/core/cache.js';

const CHECKS = [
  ['web article',          (s) => s.get('https://paulgraham.com/greatwork.html'),                       (d) => d.text.length > 5000],
  ['web JS-rendered',      (s) => s.get('https://quotes.toscrape.com/js/'),                             (d) => /Einstein|Rowling/.test(d.text)],
  ['feed (sniffed)',       (s) => s.get('https://simonwillison.net/atom/everything/'),                  (d) => (d.children?.length ?? 0) > 5],
  ['hn thread',            (s) => s.get('https://news.ycombinator.com/item?id=38792446'),               (d) => (d.children?.length ?? 0) > 10],
  ['github repo',          (s) => s.get('https://github.com/Panniantong/Agent-Reach'),                  (d) => (d.engagement?.score ?? 0) > 100],
  ['github issue',         (s) => s.get('https://github.com/microsoft/playwright/issues/1'),            (d) => d.kind === 'issue'],
  ['reddit subreddit',     (s) => s.get('https://www.reddit.com/r/LocalLLaMA/'),                        (d) => (d.children?.length ?? 0) > 5],
  ['reddit thread',        async (s) => {
                              const sub = await s.get('https://www.reddit.com/r/programming/');
                              const top = sub.children.find((c) => (c.engagement?.comments ?? 0) > 5) ?? sub.children[0];
                              return s.get(top.url);
                            },                                                                         (d) => (d.children?.length ?? 0) > 0],
  ['twitter tweet',        (s) => s.get('https://x.com/karpathy/status/1886192184808149383'),           (d) => /vibe coding/i.test(d.text)],
  ['x article (via tweet)', (s) => s.get('https://x.com/monokern/status/2105277060478382207'),         (d) => d.kind === 'article' && d.text.split(/\s+/).length > 2000],
  ['youtube metadata',     (s) => s.get('https://www.youtube.com/watch?v=zjkBMFhNj_g', { transcript: false }), (d) => /Large Language Models/.test(d.title ?? '')],
  ['youtube transcript',   (s) => s.get('https://www.youtube.com/watch?v=zjkBMFhNj_g'),                 (d) => (d.extra?.transcriptChars ?? 0) > 10000],
  ['wikipedia',            (s) => s.get('https://en.wikipedia.org/wiki/Web_scraping'),                  (d) => d.text.length > 3000],
  ['stackoverflow',        (s) => s.get('https://stackoverflow.com/questions/11227809'),                (d) => (d.children?.length ?? 0) > 3],
  ['markdown for agents',  (s) => s.get('https://blog.cloudflare.com/markdown-for-agents/'),            (d) => d.provenance.strategy === 'markdown for agents' && d.text.length > 5000],
  ['help-centre (guard)',  (s) => s.get('https://help.openai.com/en/articles/20001530-getting-started-with-your-dot'), (d) => /Which plans include dots/i.test(d.text)],
  ['map (sitemap+llms)',   async (s) => {
                              const { map } = await import('../dist/workflows/map.js');
                              const r = await map(s, 'https://docs.firecrawl.dev', { limit: 100 });
                              return { ...r, provenance: { tierName: 'native', adapter: 'map', strategy: `sitemap ${r.stats.sitemap} + llms.txt ${r.stats.llmsTxt}` } };
                            },                                                                         (r) => r.links.length >= 50],
  ['search: x (indexed)',  (s) => s.search('OpenAI dots', { source: 'twitter', limit: 5 }),            (r) => r.results.length >= 2],
  ['search: web',          (s) => s.search('playwright vs puppeteer', { source: 'websearch', limit: 5 }), (r) => r.results.length >= 3],
  ['search: fan-out',      (s) => s.search('web scraping', { limit: 2 }),                               (r) => new Set(r.results.map((x) => x.source)).size >= 5],
];

const filter = process.argv[2];
const scour = await createScour({ politenessMs: 150 });
// Bypass the cache: a canary that reads its own cache proves nothing.
Object.defineProperty(scour, 'cache', { value: new NullCache() });

let failed = 0;
for (const [name, run, ok] of CHECKS) {
  if (filter && !name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    const out = await run(scour);
    const pass = ok(out);
    if (!pass) failed++;
    const p = out.provenance;
    console.log(`${pass ? '✓' : '✗'} ${name.padEnd(20)} ${String(Date.now() - t0).padStart(6)}ms  [${p.tierName}] ${p.adapter}/${p.strategy}${pass ? '' : '  ← assertion failed'}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name.padEnd(20)} ${String(Date.now() - t0).padStart(6)}ms  ${err.message.split('\n')[0]}`);
  }
}
await scour.close();
console.log(`\n${failed === 0 ? 'all routes healthy' : `${failed} route(s) broken`} · spent $${scour.budget.spentUsd.toFixed(4)}`);
process.exitCode = failed ? 1 : 0;
