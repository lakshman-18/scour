// Compatibility check: drive a local `scour serve` with Firecrawl's OFFICIAL
// SDK (@mendable/firecrawl-js). If the SDK is happy, so is everything built
// on it. Requires network for the target pages.
import { startServer } from '../dist/server/serve.js';
import { createScour } from '../dist/index.js';
import Firecrawl, { FirecrawlAppV1 } from '@mendable/firecrawl-js';

const scour = await createScour({ politenessMs: 100 });
const srv = await startServer(scour, { port: 3999 });
const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    console.log(`✓ ${name.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${detail}`);
  } catch (err) {
    results.push(false);
    console.log(`✗ ${name.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${err.message.split('\n')[0]}`);
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const v2 = new Firecrawl({ apiKey: 'fc-local', apiUrl: srv.url });
const v1 = new FirecrawlAppV1({ apiKey: 'fc-local', apiUrl: srv.url });

await check('v2 scrape (markdown+links)', async () => {
  const d = await v2.scrape('https://paulgraham.com/greatwork.html', { formats: ['markdown', 'links'] });
  must(d.markdown?.length > 5000, `markdown too short: ${d.markdown?.length}`);
  must(Array.isArray(d.links), 'links missing');
  return `${d.markdown.length} chars, ${d.links.length} links, title "${d.metadata?.title}"`;
});
await check('v2 scrape (reddit thread)', async () => {
  const d = await v2.scrape('https://www.reddit.com/r/OpenAI/comments/1wtfsn4/openai_launches_dots_longrunning_agents/', { formats: ['markdown'] });
  must(/Comments/.test(d.markdown), 'no comments in markdown');
  return `${d.markdown.length} chars via ${d.metadata?.scourSource}/${d.metadata?.scourTier}`;
});
await check('v2 map', async () => {
  const r = await v2.map('https://docs.firecrawl.dev', { limit: 50 });
  must(r.links?.length > 10, `only ${r.links?.length} links`);
  return `${r.links.length} links, first ${r.links[0].url ?? r.links[0]}`;
});
await check('v2 crawl (waits for completion)', async () => {
  const r = await v2.crawl('https://docs.firecrawl.dev', { limit: 3, maxDiscoveryDepth: 1, pollInterval: 1 });
  must(r.status === 'completed', `status ${r.status}`);
  must(r.data?.length >= 1, 'no pages');
  return `${r.status}, ${r.data.length} pages, first "${r.data[0].metadata?.title}"`;
});
await check('v2 batch scrape', async () => {
  const r = await v2.batchScrape(['https://news.ycombinator.com/item?id=38792446', 'https://en.wikipedia.org/wiki/Web_scraping'], { options: { formats: ['markdown'] }, pollInterval: 1 });
  must(r.status === 'completed' && r.data?.length === 2, `status ${r.status}, ${r.data?.length} docs`);
  return `${r.data.length} docs: ${r.data.map((d) => d.metadata?.scourSource).join(', ')}`;
});
await check('v1 scrapeUrl', async () => {
  const d = await v1.scrapeUrl('https://x.com/OpenAI/status/2104984504133918973', { formats: ['markdown'] });
  must(d.success && /dots/i.test(d.markdown), 'tweet not returned');
  return `success=${d.success}, "${d.markdown.split('\n')[2]?.slice(0, 60)}"`;
});
await check('v1 mapUrl', async () => {
  const r = await v1.mapUrl('https://developers.cloudflare.com/workers/', { limit: 20 });
  must(r.success && r.links?.length > 5, `links ${r.links?.length}`);
  return `${r.links.length} links`;
});

await srv.close();
await scour.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} Firecrawl SDK calls succeeded against scour`);
process.exitCode = ok === results.length ? 0 : 1;
