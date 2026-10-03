import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Scour } from '../core/pipeline.js';
import { clip } from '../core/extract.js';
import { parseTier } from '../core/config.js';
import { batch } from '../workflows/batch.js';
import { crawl } from '../workflows/crawl.js';
import { watch } from '../workflows/watch.js';
import { extractStructured } from '../workflows/extract.js';
import { renderDocument, renderSearch } from '../cli/render.js';
import type { Document } from '../core/types.js';

/**
 * MCP server. Any agent that speaks MCP gets the whole engine as six tools.
 *
 * Tool outputs are Markdown, sized for a context window, with a one-line
 * provenance footer so the agent can see what each call cost.
 */
export async function startMcpServer(scour: Scour): Promise<void> {
  const server = new McpServer({ name: 'scour', version: '0.1.0' });
  const tierSchema = z.enum(['native', 'static', 'headless', 'paid']).optional()
    .describe('Cost ceiling. Default: headless (all free tiers). "paid" also needs a budget.');

  const footer = (d: Document): string =>
    `\n\n---\n_source: ${d.source} · tier: ${d.provenance.tierName} · ${d.provenance.elapsedMs}ms · $${d.provenance.costUsd.toFixed(4)}${d.provenance.cached ? ' · cached' : ''}_`;

  server.tool(
    'scour_read',
    'Read any URL and return clean Markdown. Handles Reddit threads, tweets, YouTube (with transcript), ' +
      'GitHub repos/issues/files, Hacker News, Stack Overflow, Wikipedia, RSS feeds and any normal web page. ' +
      'Results are cached, so re-reading is free.',
    {
      url: z.string().describe('The URL to read'),
      comments: z.boolean().optional().describe('Include comments/replies (default true)'),
      max_tokens: z.number().int().positive().optional().describe('Clip the body to about this many tokens (default 8000)'),
      selector: z.string().optional().describe('Only extract this CSS selector'),
      max_tier: tierSchema,
      images: z.number().int().min(0).max(10).optional().describe(
        'Attach up to N images from the page so you can see them (charts, screenshots, diagrams, dashboards). ' +
          'Use when the images may carry information the text does not. Default 0.',
      ),
    },
    async ({ url, comments, max_tokens, selector, max_tier, images }) => {
      const doc = await scour.get(url, {
        comments: comments ?? true,
        maxTier: max_tier ? parseTier(max_tier) : undefined,
        adapterOptions: { selector },
      });
      doc.text = clip(doc.text, max_tokens ?? 8000);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        { type: 'text', text: renderDocument(doc).replace(/\x1b\[[0-9;]*m/g, '') + footer(doc) },
      ];
      const available = (doc.media ?? []).filter((m) => m.type === 'image').length;
      if (images && images > 0) {
        const { fetchImages } = await import('../core/images.js');
        const r = await fetchImages(doc, { max: images, userAgent: scour.config.userAgent });
        r.images.forEach((img, i) => {
          content.push({ type: 'text', text: `Image ${i + 1} of ${r.images.length}: ${img.url}` });
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        });
        if (r.skipped.length) {
          content.push({ type: 'text', text: `Skipped ${r.skipped.length} image(s): ${r.skipped.map((x) => `${x.url} (${x.reason})`).join('; ')}` });
        }
      } else if (available > 0) {
        content.push({ type: 'text', text: `_This page has ${available} image(s). Call again with images: ${Math.min(available, 6)} to see them._` });
      }
      return { content };
    },
  );

  server.tool(
    'scour_search',
    'Search the web and platforms. With no source, searches Reddit, Hacker News, GitHub, YouTube, Stack Overflow, ' +
      'Wikipedia and the open web in parallel, drops off-topic hits and merges results. Use source to target one; ' +
      'source "twitter" finds indexed tweets without a login (popular posts, not real-time).',
    {
      query: z.string(),
      source: z.string().optional().describe('One or more, comma-separated: reddit, hn, twitter, youtube, github, stackoverflow, wikipedia, bluesky, arxiv, npm, websearch. Omit for all.'),
      limit: z.number().int().min(1).max(50).optional(),
      sort: z.enum(['relevance', 'engagement', 'recent']).optional().describe('Default relevance'),
    },
    async ({ query, source, limit, sort }) => {
      const res = await scour.search(query, { source, limit: limit ?? 8, sort });
      return {
        content: [{
          type: 'text',
          text: `${renderSearch(res.results).replace(/\x1b\[[0-9;]*m/g, '')}\n\n_${res.results.length} results via ${res.provenance.strategy} · ${res.provenance.elapsedMs}ms_`,
        }],
      };
    },
  );

  server.tool(
    'scour_research',
    'Research a question: searches the chosen sources, reads the best results in full, and returns one pack of ' +
      'numbered sources with their content. Answer from the pack and cite sources like [3]. Best first step for ' +
      '"what is X", "what are people saying about X", "compare X and Y".',
    {
      question: z.string(),
      sources: z.string().optional().describe('Comma-separated (reddit, hn, twitter, youtube, github, web, …). Default: all.'),
      limit: z.number().int().min(2).max(15).optional().describe('Documents to read in full (default 6)'),
    },
    async ({ question, sources, limit }) => {
      const { research } = await import('../workflows/research.js');
      const pack = await research(scour, question, { sources, limit: limit ?? 6, perDocTokens: 1200 });
      const note = pack.errors.length ? `\n\n_${pack.errors.length} result(s) could not be read._` : '';
      return { content: [{ type: 'text', text: `${pack.markdown}${note}\n\n_${pack.stats.read} sources · ${(pack.stats.elapsedMs / 1000).toFixed(1)}s · $${pack.stats.costUsd.toFixed(4)}_` }] };
    },
  );

  server.tool(
    'scour_read_many',
    'Read several URLs in parallel. Partial failures are reported, not thrown.',
    {
      urls: z.array(z.string()).min(1).max(50),
      max_tokens_each: z.number().int().positive().optional().describe('Per-document clip (default 3000)'),
    },
    async ({ urls, max_tokens_each }) => {
      const res = await batch(scour, urls, { comments: false });
      const body = res.documents
        .map((d) => `## ${d.title ?? d.url}\n${d.url}\n\n${clip(d.text, max_tokens_each ?? 3000)}`)
        .join('\n\n---\n\n');
      const errs = res.errors.length ? `\n\n**Failed (${res.errors.length}):**\n${res.errors.map((e) => `- ${e.url}: ${e.error.split('\n')[0]}`).join('\n')}` : '';
      return { content: [{ type: 'text', text: `${body}${errs}\n\n_${res.stats.ok}/${res.stats.total} ok · ${res.stats.cached} cached · ${(res.stats.elapsedMs / 1000).toFixed(1)}s_` }] };
    },
  );

  server.tool(
    'scour_crawl',
    'Crawl a website breadth-first (sitemap-seeded when available) and return page summaries. Bounded by default.',
    {
      url: z.string(),
      depth: z.number().int().min(0).max(4).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      include: z.string().optional().describe('Only follow URLs matching this regex'),
    },
    async ({ url, depth, limit, include }) => {
      const res = await crawl(scour, url, {
        depth: depth ?? 1, limit: limit ?? 20,
        include: include ? new RegExp(include) : undefined,
      });
      const body = res.documents
        .map((d) => `- **${d.title ?? d.url}** — ${d.url}\n  ${(d.excerpt ?? d.text.slice(0, 200)).replace(/\s+/g, ' ')}`)
        .join('\n');
      return { content: [{ type: 'text', text: `${body}\n\n_${res.stats.visited} pages · ${res.errors.length} errors · ${(res.stats.elapsedMs / 1000).toFixed(1)}s_` }] };
    },
  );

  server.tool(
    'scour_screenshot',
    'See a web page as a browser renders it (layout, charts, visual state). Returns an image. ' +
      'Use when the visual matters; use scour_read for the text.',
    {
      url: z.string(),
      full_page: z.boolean().optional().describe('Capture the whole scrolling page (default: first screen)'),
      mobile: z.boolean().optional().describe('Emulate a phone'),
      selector: z.string().optional().describe('Capture only this element'),
    },
    async ({ url, full_page, mobile, selector }) => {
      const shot = await scour.screenshot(url, { fullPage: !!full_page, mobile: !!mobile, selector, format: 'jpeg', quality: 70 });
      return {
        content: [
          { type: 'text', text: `Screenshot of ${shot.url}${shot.title ? ` — ${shot.title}` : ''} (${Math.round(shot.data.length / 1024)} KB)` },
          { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType },
        ],
      };
    },
  );

  server.tool(
    'scour_map',
    "List a website's URLs from its sitemap, llms.txt and page links without fetching them. " +
      'Use before crawling to find the right pages; pass search to filter by keyword.',
    {
      url: z.string(),
      search: z.string().optional().describe('Only URLs whose address or title contains this'),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ url, search, limit }) => {
      const { map } = await import('../workflows/map.js');
      const r = await map(scour, url, { search, limit: limit ?? 200 });
      const lines = r.links.map((l) => `- ${l.title ? `${l.title} — ` : ''}${l.url}`);
      return {
        content: [{
          type: 'text',
          text: `${lines.join('\n')}\n\n_${r.links.length} URLs · sitemap ${r.stats.sitemap}, llms.txt ${r.stats.llmsTxt}, page ${r.stats.page} · ${r.stats.elapsedMs}ms_`,
        }],
      };
    },
  );

  server.tool(
    'scour_watch',
    'Check a URL for changes since the last time it was checked. For feeds/listings, returns only NEW items. ' +
      'The first call establishes a baseline.',
    { url: z.string(), label: z.string().optional() },
    async ({ url, label }) => {
      const r = await watch(scour, url, { label });
      let text: string;
      if (r.kind === 'first-run') text = `Baseline recorded for ${r.url}. Call again later to see what changed.`;
      else if (!r.changed) text = `No changes since ${r.previousSeenAt}.`;
      else if (r.newItems.length) {
        text = `${r.newItems.length} new item(s) since ${r.previousSeenAt}:\n\n` +
          r.newItems.map((n) => `- **${n.title ?? n.id}** — ${n.url}${n.excerpt ? `\n  ${n.excerpt}` : ''}`).join('\n');
      } else text = `Content changed since ${r.previousSeenAt}:\n\n\`\`\`diff\n${r.diff}\n\`\`\``;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'scour_extract',
    'Extract structured JSON from a page using CSS selectors. Deterministic and free. ' +
      'fields maps name → selector; append @attr to read an attribute (e.g. "a@href"). ' +
      'Set list to a selector to get one record per matching element.',
    {
      url: z.string(),
      fields: z.record(z.string()),
      list: z.string().optional(),
    },
    async ({ url, fields, list }) => {
      const res = await extractStructured(scour, url, { fields, list });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await scour.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
