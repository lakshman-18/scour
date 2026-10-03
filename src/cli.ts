#!/usr/bin/env node
import { Command, Option } from 'commander';
import { promises as fs } from 'node:fs';
import { createScour, defaultRegistry } from './index.js';
import { ConsoleLogger, color, type LogLevel } from './core/logger.js';
import { FileCache } from './core/cache.js';
import { loadConfig, parseTier, saveCredentials, saveProviders, configHome } from './core/config.js';
import { clip } from './core/extract.js';
import { Scour } from './core/pipeline.js';
import { batch } from './workflows/batch.js';
import { crawl } from './workflows/crawl.js';
import { watch, watchAll, listWatches, removeWatch, clearWatches } from './workflows/watch.js';
import { renderDocument, renderSearch, slimDocument, statsLine } from './cli/render.js';
import { Tier, type FetchOptions, type ScourConfig } from './core/types.js';

const program = new Command();
const logger = new ConsoleLogger('warn');

program
  .name('scour')
  .description('Give your agent eyes. Read and search anything on the internet — cheaply.')
  .version('0.1.0')
  .option('-v, --verbose', 'show the tier ladder and fallbacks on stderr')
  .option('-q, --quiet', 'errors only')
  .option('--json', 'emit JSON instead of Markdown')
  .option('--max-tier <tier>', 'cost ceiling: cache | native | static | headless | paid')
  .option('--max-cost <usd>', 'hard spend cap in USD for this run (default 0 — free tiers only)')
  .option('--ttl <seconds>', 'cache lifetime (0 disables reads)')
  .option('--no-cache', 'ignore cached entries for this run')
  .option('--timeout <ms>', 'per-request timeout')
  .option('--proxy <url>', 'http(s) proxy')
  .option('--concurrency <n>', 'parallel requests')
  .option('--stats', 'print tier, timing and cost to stderr');

// ---------------------------------------------------------------- get
program
  .command('get', { isDefault: true })
  .description('Fetch one or more URLs and print clean Markdown')
  .argument('<urls...>', 'URLs to read (or - to read a list from stdin)')
  .option('-c, --comments [n]', 'include comments/replies (default: all available)')
  .option('--no-comments', 'skip comments')
  .option('--no-transcript', 'skip video transcripts')
  .option('-s, --selector <css>', 'extract only this CSS selector')
  .option('-f, --full', 'keep the whole page instead of the main article')
  .option('--max-tokens <n>', 'clip the body to roughly N tokens')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .option('--save-images <dir>', "download the page's images into this folder (to view, share, or hand to an AI)")
  .action(async (urls: string[], cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const list = urls.includes('-') ? await readStdinList() : urls;
    const opts: FetchOptions = {
      ...fetchOptionsFrom(g),
      comments: cmdOpts.comments === true ? true : cmdOpts.comments === false ? false : cmdOpts.comments ? Number(cmdOpts.comments) : undefined,
      transcript: cmdOpts.transcript,
      adapterOptions: { selector: cmdOpts.selector, full: cmdOpts.full },
    };

    if (list.length === 1) {
      const doc = await scour.get(list[0]!, opts);
      if (cmdOpts.maxTokens) doc.text = clip(doc.text, Number(cmdOpts.maxTokens));
      const out = g.json ? JSON.stringify(slimDocument(doc, !!opts.comments), null, 2) : renderDocument(doc);
      await emit(out, cmdOpts.out);
      if (g.stats) process.stderr.write(`${color.dim(statsLine(doc))}\n`);
      if (cmdOpts.saveImages) await saveImages(doc, cmdOpts.saveImages);
      await scour.close();
      return;
    }

    const res = await batch(scour, list, {
      ...opts,
      concurrency: g.concurrency ? Number(g.concurrency) : undefined,
      onProgress: (done, total, url, ok) =>
        g.verbose && process.stderr.write(`${ok ? color.green('✓') : color.red('✗')} ${done}/${total} ${url}\n`),
    });
    for (const d of res.documents) if (cmdOpts.maxTokens) d.text = clip(d.text, Number(cmdOpts.maxTokens));
    const out = g.json
      ? JSON.stringify({ documents: res.documents.map((d) => slimDocument(d, !!opts.comments)), errors: res.errors, stats: res.stats }, null, 2)
      : res.documents.map((d) => renderDocument(d)).join('\n\n---\n\n');
    await emit(out, cmdOpts.out);
    reportBatch(res, g.stats);
    await scour.close();
    if (res.errors.length && res.documents.length === 0) process.exitCode = 1;
  });

// ---------------------------------------------------------------- search
program
  .command('search')
  .description('Search across platforms at once, or one source with --source')
  .argument('<query...>')
  .option('-s, --source <name>', 'reddit | hn | github | youtube | wikipedia | stackoverflow | websearch')
  .option('-n, --limit <n>', 'results per source', '10')
  .option('--fetch', 'also fetch the full text of every result')
  .action(async (queryParts: string[], cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const query = queryParts.join(' ');
    const res = await scour.search(query, { ...fetchOptionsFrom(g), source: cmdOpts.source, limit: Number(cmdOpts.limit) });

    if (cmdOpts.fetch) {
      const b = await batch(scour, res.results.map((r) => r.url), fetchOptionsFrom(g));
      const out = g.json
        ? JSON.stringify({ query, documents: b.documents.map((d) => slimDocument(d, false)), errors: b.errors, stats: b.stats }, null, 2)
        : b.documents.map((d) => renderDocument(d)).join('\n\n---\n\n');
      await emit(out);
      reportBatch(b, g.stats);
    } else {
      await emit(g.json ? JSON.stringify(res, null, 2) : renderSearch(res.results));
      if (g.stats) process.stderr.write(`${color.dim(`${res.results.length} results · ${res.provenance.elapsedMs}ms · $${res.provenance.costUsd.toFixed(4)} · via ${res.provenance.strategy}`)}\n`);
    }
    await scour.close();
  });

// ---------------------------------------------------------------- crawl
program
  .command('crawl')
  .description('Walk a site breadth-first (sitemap-seeded when available)')
  .argument('<url>')
  .option('-d, --depth <n>', 'link depth from the seed', '2')
  .option('-n, --limit <n>', 'maximum pages', '50')
  .option('--all-hosts', 'follow links off the seed host')
  .option('--include <regex>', 'only follow URLs matching this')
  .option('--exclude <regex>', 'never follow URLs matching this')
  .option('--no-sitemap', 'do not seed from /sitemap.xml')
  .option('--no-robots', 'ignore robots.txt')
  .option('-o, --out <file>', 'write to a file (.json or .md by extension)')
  .action(async (url: string, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const res = await crawl(scour, url, {
      ...fetchOptionsFrom(g),
      depth: Number(cmdOpts.depth),
      limit: Number(cmdOpts.limit),
      sameHost: !cmdOpts.allHosts,
      include: cmdOpts.include ? new RegExp(cmdOpts.include) : undefined,
      exclude: cmdOpts.exclude ? new RegExp(cmdOpts.exclude) : undefined,
      useSitemap: cmdOpts.sitemap,
      respectRobots: cmdOpts.robots,
      concurrency: g.concurrency ? Number(g.concurrency) : undefined,
      onPage: (doc, depth, queued) =>
        g.verbose && process.stderr.write(`${color.green('✓')} d${depth} q${queued} ${doc.url}\n`),
    });
    const asJson = g.json || cmdOpts.out?.endsWith('.json');
    const out = asJson
      ? JSON.stringify({ documents: res.documents.map((d) => slimDocument(d, false)), errors: res.errors, stats: res.stats }, null, 2)
      : res.documents.map((d) => renderDocument(d)).join('\n\n---\n\n');
    await emit(out, cmdOpts.out);
    process.stderr.write(
      color.dim(`crawled ${res.stats.visited} pages (${res.stats.discovered} discovered${res.stats.seededFromSitemap ? ', sitemap-seeded' : ''}) in ${(res.stats.elapsedMs / 1000).toFixed(1)}s · $${res.stats.costUsd.toFixed(4)}\n`),
    );
    if (res.errors.length) process.stderr.write(color.yellow(`${res.errors.length} failed\n`));
    await scour.close();
  });

// ---------------------------------------------------------------- watch
program
  .command('watch')
  .description('Report only what changed since the last check, and alert you (cron-safe)')
  .argument('[url]')
  .option('-a, --all', 'check every registered watch')
  .option('-l, --list', 'list registered watches')
  .option('--label <name>', 'friendly name for this watch')
  .option('-n, --notify <target...>', 'alert on change: slack:URL | discord:URL | telegram:CHAT@TOKEN | ntfy:TOPIC | webhook:URL | macos (saved with the watch)')
  .option('--every <interval>', 'keep running, checking every interval (e.g. 15m, 1h, 1d)')
  .option('--test-notify', 'send a test alert to the given --notify targets and exit')
  .option('--remove', 'stop watching this URL')
  .option('--clear', 'remove every watch')
  .option('--reset', 'forget history and re-baseline')
  .option('--quiet-if-unchanged', 'print nothing when nothing changed')
  .action(async (url: string | undefined, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const { parseNotify, notifyAll, redact } = await import('./workflows/notify.js');
    const cliNotify: string[] = cmdOpts.notify ?? [];
    // Validate targets up front so a typo fails now, not at 3am on the first change.
    for (const spec of cliNotify) parseNotify(spec);

    if (cmdOpts.testNotify) {
      if (!cliNotify.length) { program.error('--test-notify needs at least one --notify target'); return; }
      const fake = {
        url: url ?? 'https://example.com', label: cmdOpts.label ?? 'scour test', changed: true, kind: 'new-items' as const,
        newItems: [{ id: 't', url: 'https://example.com/item', title: 'This is a test alert from scour', source: 'web', kind: 'post' as const, text: '', provenance: {} as never }],
        document: {} as never, checkedAt: new Date().toISOString(),
      };
      for (const r of await notifyAll(cliNotify.map(parseNotify), fake)) {
        console.log(`${r.ok ? color.green('✓') : color.red('✗')} ${r.kind}${r.error ? `: ${r.error}` : ''}`);
      }
      return;
    }

    if (cmdOpts.list) {
      const all = await listWatches();
      if (!all.length) { console.log('No watches registered. Add one with: scour watch <url>'); return; }
      for (const w of all) {
        const alerts = (w.notify ?? []).map((n) => { try { const p = parseNotify(n); return `${p.kind} ${p.kind === 'webhook' || p.kind === 'slack' || p.kind === 'discord' ? redact(p.target) : p.target}`; } catch { return n; } });
        console.log(`${color.bold(w.label ?? w.url)}\n  ${color.cyan(w.url)}\n  ${color.dim(`${w.runs} runs · last change ${w.lastChangedAt.slice(0, 16).replace('T', ' ')}${alerts.length ? ` · alerts: ${alerts.join(', ')}` : ''}`)}`);
      }
      return;
    }
    if (cmdOpts.clear) { console.log(`Removed ${await clearWatches()} watches.`); return; }
    if (cmdOpts.remove) {
      if (!url) { program.error('watch --remove needs a URL'); return; }
      console.log((await removeWatch(url)) ? `Stopped watching ${url}` : `No watch found for ${url}`);
      return;
    }
    if (!url && !cmdOpts.all) { program.error('watch needs a URL, or --all / --list'); return; }

    const scour = await makeScour(g);
    const runOnce = async (): Promise<number> => {
      const results = cmdOpts.all
        ? await watchAll(scour, { ...fetchOptionsFrom(g) })
        : [await watch(scour, url!, { ...fetchOptionsFrom(g), label: cmdOpts.label, reset: cmdOpts.reset, notify: cliNotify })];
      const changed = results.filter((r) => r.changed);
      const stamp = color.dim(new Date().toISOString().slice(0, 16).replace('T', ' '));

      if (g.json) {
        await emit(JSON.stringify(results.map((r) => ({ ...r, document: slimDocument(r.document, false), newItems: r.newItems.map((n) => slimDocument(n, false)) })), null, 2));
      } else if (changed.length === 0) {
        if (!cmdOpts.quietIfUnchanged) {
          const firstRuns = results.filter((r) => r.kind === 'first-run');
          console.log(cmdOpts.every ? `${stamp} no changes` : firstRuns.length ? `Baselined ${firstRuns.length} watch(es). Future runs will report only changes.` : 'No changes.');
        }
      } else {
        for (const r of changed) {
          console.log(color.bold(`\n## ${r.label ?? r.url}`));
          console.log(color.dim(`${r.kind} · last seen ${r.previousSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never'}`));
          if (r.newItems.length) {
            console.log(`\n${r.newItems.length} new item(s):\n`);
            for (const n of r.newItems) console.log(`- ${color.bold(n.title ?? n.id)}\n  ${color.cyan(n.url)}${n.excerpt ? `\n  ${n.excerpt}` : ''}`);
          }
          if (r.diff) console.log(`\n${r.diff}`);
        }
      }

      // Alerts: each watch's saved targets, plus any given on this command line.
      for (const r of changed) {
        const specs = [...new Set([...(r.notify ?? []), ...cliNotify])];
        if (!specs.length) continue;
        for (const s of await notifyAll(specs.map(parseNotify), r)) {
          process.stderr.write(`${s.ok ? color.green('  ↳ alerted') : color.red('  ↳ alert failed')} ${s.kind}${s.error ? `: ${s.error}` : ''}\n`);
        }
      }
      return changed.length;
    };

    if (!cmdOpts.every) {
      const changedCount = await runOnce();
      await scour.close();
      // Exit 1 on change so shell pipelines can branch on it (diff(1) convention).
      process.exitCode = changedCount ? 1 : 0;
      return;
    }

    const intervalMs = parseInterval(cmdOpts.every);
    process.stderr.write(color.dim(`watching ${cmdOpts.all ? 'all registered URLs' : url} every ${cmdOpts.every} · Ctrl-C to stop\n`));
    let stopping = false;
    process.on('SIGINT', () => { stopping = true; void scour.close().then(() => process.exit(0)); });
    while (!stopping) {
      try {
        await runOnce();
      } catch (err) {
        // A failed check (site down, network blip) must not kill a long-running watch.
        process.stderr.write(color.yellow(`! check failed: ${(err as Error).message.split('\n')[0]}\n`));
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  });

function parseInterval(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(v.trim());
  if (!m) throw new Error(`Bad interval "${v}". Use e.g. 30s, 15m, 1h, 1d.`);
  const n = Number(m[1]) * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 } as Record<string, number>)[(m[2] ?? 'm').toLowerCase()]!;
  if (n < 30_000) throw new Error('Minimum --every is 30s; be kind to the sites you watch.');
  return n;
}

// ---------------------------------------------------------------- extract
program
  .command('extract')
  .description('Pull structured JSON out of a page with CSS selectors')
  .argument('<url>')
  .requiredOption('-f, --field <name=selector...>', 'field mapping, e.g. price=.price title=h1')
  .option('--list <selector>', 'repeat the fields for every element matching this')
  .option('--attr <name>', 'read this attribute instead of the text', '')
  .action(async (url: string, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { extractStructured } = await import('./workflows/extract.js');
    const fields: Record<string, string> = {};
    for (const f of cmdOpts.field as string[]) {
      const i = f.indexOf('=');
      if (i < 1) program.error(`--field must be name=selector, got "${f}"`);
      fields[f.slice(0, i)] = f.slice(i + 1);
    }
    const data = await extractStructured(scour, url, { fields, list: cmdOpts.list, attr: cmdOpts.attr || undefined, options: fetchOptionsFrom(g) });
    await emit(JSON.stringify(data, null, 2));
    await scour.close();
  });

// ---------------------------------------------------------------- screenshot
program
  .command('screenshot')
  .description('Save an image of a page as a browser shows it (needs Playwright)')
  .argument('<url>')
  .option('-o, --out <file>', 'output file (.png or .jpg)', 'screenshot.png')
  .option('-f, --full-page', 'capture the whole scrolling page')
  .option('--mobile', 'emulate a phone')
  .option('--width <px>', 'viewport width')
  .option('--height <px>', 'viewport height')
  .option('-s, --selector <css>', 'capture only this element')
  .option('--wait <ms>', 'extra settle time after load', '800')
  .action(async (url: string, o, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const format = /\.jpe?g$/i.test(o.out) ? 'jpeg' : 'png';
    const shot = await scour.screenshot(url, {
      fullPage: !!o.fullPage, mobile: !!o.mobile, format, selector: o.selector,
      width: o.width ? Number(o.width) : undefined, height: o.height ? Number(o.height) : undefined, waitMs: Number(o.wait),
    });
    await fs.writeFile(o.out, shot.data);
    process.stderr.write(color.dim(`saved ${o.out} (${(shot.data.length / 1024).toFixed(0)} KB) · ${shot.title ?? shot.url}\n`));
    await scour.close();
  });

// ---------------------------------------------------------------- map
program
  .command('map')
  .description("List a site's URLs from its sitemap, llms.txt and links, without fetching the pages")
  .argument('<url>')
  .option('--search <text>', 'only URLs whose address or title contains this')
  .option('-n, --limit <n>', 'maximum URLs', '5000')
  .option('--subdomains', 'include subdomains')
  .option('--no-sitemap', 'skip sitemap.xml')
  .action(async (url: string, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { map } = await import('./workflows/map.js');
    const r = await map(scour, url, {
      ...fetchOptionsFrom(g),
      search: cmdOpts.search,
      limit: Number(cmdOpts.limit),
      includeSubdomains: !!cmdOpts.subdomains,
      ignoreSitemap: cmdOpts.sitemap === false,
    });
    await emit(g.json ? JSON.stringify(r, null, 2) : r.links.map((l) => l.url).join('\n'));
    process.stderr.write(color.dim(`${r.links.length} URLs (sitemap ${r.stats.sitemap}, llms.txt ${r.stats.llmsTxt}, page ${r.stats.page}) in ${r.stats.elapsedMs}ms\n`));
    await scour.close();
  });

// ---------------------------------------------------------------- serve
program
  .command('serve')
  .description('Run a local HTTP API (Firecrawl-compatible /v1 and /v2, plus /scour/*)')
  .option('-p, --port <n>', 'port (3002 matches self-hosted Firecrawl)', '3002')
  .option('--host <host>', 'interface to bind; anything but localhost requires --api-key', '127.0.0.1')
  .option('--api-key <key>', 'require this Bearer token (default: $SCOUR_API_KEY)')
  .action(async (cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { startServer } = await import('./server/serve.js');
    const srv = await startServer(scour, {
      port: Number(cmdOpts.port),
      host: cmdOpts.host,
      apiKey: cmdOpts.apiKey ?? process.env.SCOUR_API_KEY,
      log: g.quiet ? undefined : (line) => process.stderr.write(color.dim(`${new Date().toISOString().slice(11, 19)} ${line}\n`)),
    });
    process.stderr.write(
      `${color.green('●')} scour API on ${color.bold(srv.url)}\n` +
        color.dim(`  Firecrawl-compatible: POST ${srv.url}/v1/scrape · /v1/crawl · /v1/map · /v1/search (and /v2/*)\n`) +
        color.dim(`  Point any Firecrawl client at it: FIRECRAWL_API_URL=${srv.url}\n`) +
        color.dim(`  Native: GET ${srv.url}/scour/get?url=… · /scour/search?q=… · POST /scour/watch · /scour/extract\n`),
    );
    const stop = async () => {
      await srv.close();
      await scour.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

// ---------------------------------------------------------------- setup
program
  .command('setup')
  .description('Plug scour into your AI tools: Claude Code MCP + skill (default), Claude Desktop, Cursor')
  .option('--claude-code', 'register the MCP server with Claude Code (user scope)')
  .option('--claude-desktop', 'add the MCP server to Claude Desktop')
  .option('--cursor', 'add the MCP server to Cursor')
  .option('--skill', 'install the Claude Code skill that teaches Claude when to use scour')
  .option('--all', 'all of the above')
  .option('--remove', 'undo instead of install')
  .option('--dry-run', 'show what would change without changing anything')
  .action(async (o) => {
    const { runSetup } = await import('./setup.js');
    type T = 'claude-code' | 'claude-desktop' | 'cursor' | 'skill';
    let targets: T[] = [];
    if (o.all) targets = ['claude-code', 'claude-desktop', 'cursor', 'skill'];
    else {
      if (o.claudeCode) targets.push('claude-code');
      if (o.claudeDesktop) targets.push('claude-desktop');
      if (o.cursor) targets.push('cursor');
      if (o.skill) targets.push('skill');
    }
    if (!targets.length) targets = ['claude-code', 'skill'];
    const icon: Record<string, string> = {
      added: color.green('+'), updated: color.green('~'), removed: color.yellow('-'), already: color.dim('='),
      absent: color.dim('·'), skipped: color.dim('·'), 'would-add': color.cyan('+?'), 'would-remove': color.cyan('-?'), failed: color.red('✗'),
    };
    for (const s of await runSetup(targets, { remove: o.remove, dryRun: o.dryRun })) {
      console.log(`${icon[s.action]} ${color.bold(s.target.padEnd(15))} ${s.action.padEnd(12)} ${color.dim(s.detail)}`);
    }
  });

// ---------------------------------------------------------------- doctor
program
  .command('doctor')
  .description('Show what works right now, what is limited, and exactly how to fix it')
  .action(async (_o, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const reports = await scour.health();
    const icon = { ready: color.green('●'), degraded: color.yellow('◐'), 'needs-config': color.yellow('○'), down: color.red('✗') };
    console.log(color.bold('\nscour doctor\n'));
    for (const r of reports.sort((a, b) => a.adapter.localeCompare(b.adapter))) {
      console.log(`${icon[r.status]} ${color.bold(r.adapter.padEnd(14))} ${r.detail}`);
      if (r.capabilities.length) console.log(`  ${color.dim(r.capabilities.join(', '))}`);
      if (r.fix) console.log(`  ${color.cyan('fix:')} ${r.fix}`);
      console.log('');
    }
    const { usageSummary } = await import('./core/usage.js');
    const p = scour.config.providers;
    const used = await usageSummary();
    const lines = [
      p.tavilyKey && `tavily ${used.tavily!.used}/${used.tavily!.free} free`,
      p.braveKey && `brave ${used.brave!.used}/${used.brave!.free} free`,
      p.xBearerToken && `x-api ${used['x-api-posts']!.used} posts ($${(used['x-api-posts']!.used * 0.005).toFixed(2)})`,
    ].filter(Boolean);
    if (lines.length) console.log(color.dim(`this month: ${lines.join(' · ')}`));
    const cache = await new FileCache(scour.config.cacheDir).stats();
    console.log(color.dim(`cache: ${cache.entries} entries, ${(cache.bytes / 1024 / 1024).toFixed(1)} MB at ${scour.config.cacheDir}`));
    console.log(color.dim(`config: ${configHome()} · max-tier ${Tier[scour.config.maxTier]} · cap $${scour.config.maxCostUsd.toFixed(2)}`));
    const { isRenderAvailable } = await import('./render/browser.js');
    console.log(color.dim(`headless: ${(await isRenderAvailable()) ? 'playwright installed' : 'not installed (npm i playwright for JS-heavy sites)'}`));
    await scour.close();
  });

// ---------------------------------------------------------------- cache
const cacheCmd = program.command('cache').description('Inspect and manage the local cache');
cacheCmd.command('stats').action(async () => {
  const cfg = await loadConfig();
  const s = await new FileCache(cfg.cacheDir).stats();
  console.log(`${s.entries} entries · ${(s.bytes / 1024 / 1024).toFixed(2)} MB\n${cfg.cacheDir}`);
});
cacheCmd.command('clear').action(async () => {
  const cfg = await loadConfig();
  console.log(`Cleared ${await new FileCache(cfg.cacheDir).clear()} entries.`);
});
cacheCmd.command('prune').description('Drop expired entries only').action(async () => {
  const cfg = await loadConfig();
  console.log(`Pruned ${await new FileCache(cfg.cacheDir).prune()} expired entries.`);
});

// ---------------------------------------------------------------- auth
program
  .command('auth')
  .description('Store a key or credential locally (0600 in ~/.scour). Run with no value to be prompted with hidden input.')
  .argument('<service>', 'tavily | brave | searxng | x-api | github | reddit | twitter')
  .option('--key <value>', 'API key (tavily, brave)')
  .option('--token <value>', 'token (github, x-api)')
  .option('--url <value>', 'SearXNG base URL')
  .option('--client-id <value>', 'Reddit script app client id')
  .option('--client-secret <value>', 'Reddit script app secret')
  .option('--auth-token <value>', 'X auth_token cookie (unofficial route)')
  .option('--ct0 <value>', 'X ct0 cookie (unofficial route)')
  .option('--help-only', 'just print how to get this credential')
  .action(async (service: string, o) => {
    const svc = service.toLowerCase();
    if (!AUTH_HELP[svc]) { program.error(`Unknown service "${service}". Use: ${Object.keys(AUTH_HELP).join(', ')}`); return; }
    if (o.helpOnly) { console.log(`\n${AUTH_HELP[svc]}\n`); return; }
    // Values given as flags end up in shell history; prompting hides them.
    const ask = async (flag: string | undefined, label: string): Promise<string> => {
      if (flag) return flag;
      if (!process.stdin.isTTY) throw new Error(`${label} is required (pass it as a flag, or run in a terminal to be prompted).`);
      const v = (await promptHidden(`${label}: `)).trim();
      if (!v) throw new Error(`${label} was empty; nothing saved.`);
      return v;
    };
    if (!process.stdin.isTTY || (!o.key && !o.token && !o.url && !o.clientId && !o.authToken)) console.log(`\n${AUTH_HELP[svc]}\n`);
    let file: string;
    switch (svc) {
      case 'tavily': file = await saveProviders({ tavilyKey: await ask(o.key, 'Tavily API key (tvly-…)') }); break;
      case 'brave': file = await saveProviders({ braveKey: await ask(o.key, 'Brave Search API key') }); break;
      case 'searxng': file = await saveProviders({ searxngUrl: await ask(o.url, 'SearXNG base URL') }); break;
      case 'x-api': file = await saveProviders({ xBearerToken: await ask(o.token, 'X API bearer token') }); break;
      case 'github': file = await saveCredentials({ githubToken: await ask(o.token, 'GitHub token') }); break;
      case 'reddit':
        file = await saveCredentials({ reddit: { clientId: await ask(o.clientId, 'Reddit client id'), clientSecret: await ask(o.clientSecret, 'Reddit client secret') } });
        break;
      case 'twitter':
        file = await saveCredentials({ twitter: { authToken: await ask(o.authToken, 'auth_token cookie'), ct0: await ask(o.ct0, 'ct0 cookie') } });
        break;
      default: return;
    }
    console.log(`${color.green('✓')} saved to ${file} (mode 0600). Check it with: scour doctor`);
  });

const AUTH_HELP: Record<string, string> = {
  tavily:
    'Tavily: reliable web search, and the engine behind X topic search without login.\n' +
    '  Free: 1,000 searches/month, no credit card. scour stops at 950/month so you are never billed.\n' +
    '  1. Sign up at https://app.tavily.com and copy your API key (starts with tvly-)\n' +
    '  2. scour auth tavily            (you will be prompted; the key is hidden)',
  brave:
    'Brave Search: needs a card on file. $5 of credit each month (~1,000 searches), then $5 per 1,000\n' +
    '  with no spending cap on Brave\'s side. scour counts usage and stops at 950/month unless you raise --max-cost.\n' +
    '  1. https://api-dashboard.search.brave.com  2. scour auth brave',
  searxng:
    'SearXNG: self-hosted meta-search, no key, no quota (needs Docker).\n' +
    '  1. docker run -d -p 8888:8080 searxng/searxng   (enable the json format in settings.yml)\n' +
    '  2. scour auth searxng --url http://localhost:8888',
  'x-api':
    'Official X API: live, complete X search with no account risk. Pay-per-use: $0.005 per post read\n' +
    '  (100 posts = $0.50). scour only calls it when --max-cost allows, and charges the cap before each call.\n' +
    '  1. Create an app at https://developer.x.com and add credit\n' +
    '  2. Copy the app\'s Bearer Token, then: scour auth x-api\n' +
    '  3. Use it: scour search "topic" -s twitter --max-cost 0.50',
  github:
    'GitHub: lifts 60 → 5000 requests/hour and unlocks private repos. No scopes needed for public data.\n' +
    '  Easiest: scour auth github --token "$(gh auth token)"   or create one at https://github.com/settings/tokens',
  reddit:
    'Reddit: only needed for exact post vote counts / native search. Create a free "script" app at\n' +
    '  https://www.reddit.com/prefs/apps, then: scour auth reddit',
  twitter:
    'X session cookies (UNOFFICIAL, not recommended): automating a logged-in session breaks X\'s terms and can get\n' +
    '  the account rate-limited, locked or suspended. Prefer the official API (scour auth x-api --help-only).\n' +
    '  If you still choose this, use a spare account: log in to x.com yourself, export auth_token and ct0\n' +
    '  with the Cookie-Editor extension, then run: scour auth twitter   (prompted, hidden). Never share them in chat.',
};

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { value = value.slice(0, -1); continue; }
        value += c;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------- mcp
program
  .command('mcp')
  .description('Run as an MCP server over stdio (for Claude Code, Cursor, etc.)')
  .action(async (_o, cmd) => {
    const g = cmd.parent.opts();
    const { startMcpServer } = await import('./mcp/server.js');
    await startMcpServer(await makeScour({ ...g, quiet: true }));
  });

// ---------------------------------------------------------------- sources
program
  .command('sources')
  .description('List built-in adapters and which URLs they claim')
  .action(() => {
    const reg = defaultRegistry();
    console.log(color.bold('\nBuilt-in adapters (highest priority first)\n'));
    for (const a of reg.all) {
      const caps = [a.search ? 'search' : null, a.health ? 'doctor' : null].filter(Boolean).join(', ');
      console.log(`  ${color.bold(a.name.padEnd(14))} priority ${String(a.priority ?? 0).padStart(5)}${caps ? `  ${color.dim(`[${caps}]`)}` : ''}`);
    }
    console.log(color.dim('\n  Anything unmatched falls through to "web", which handles the rest of the internet.\n'));
  });

// ---------------------------------------------------------------- plumbing
async function makeScour(g: Record<string, unknown>): Promise<Scour> {
  const level: LogLevel = g.quiet ? 'error' : g.verbose ? 'debug' : 'warn';
  logger.setLevel(level);
  const overrides: Partial<ScourConfig> = {};
  if (g.maxTier) overrides.maxTier = parseTier(String(g.maxTier));
  if (g.maxCost !== undefined) overrides.maxCostUsd = Number(g.maxCost);
  if (g.timeout) overrides.timeoutMs = Number(g.timeout);
  if (g.proxy) overrides.proxy = String(g.proxy);
  if (g.concurrency) overrides.concurrency = Number(g.concurrency);
  if (g.ttl !== undefined) overrides.defaultTtlSec = Number(g.ttl);
  // Raising the cap above zero implies the user wants paid tiers reachable.
  if (overrides.maxCostUsd && overrides.maxCostUsd > 0 && !g.maxTier) overrides.maxTier = Tier.Paid;
  return createScour(overrides, logger);
}

function fetchOptionsFrom(g: Record<string, unknown>): FetchOptions {
  return {
    noCache: g.cache === false,
    ttl: g.ttl !== undefined ? Number(g.ttl) : undefined,
    maxTier: g.maxTier ? parseTier(String(g.maxTier)) : undefined,
    timeoutMs: g.timeout ? Number(g.timeout) : undefined,
    proxy: g.proxy ? String(g.proxy) : undefined,
  };
}

async function emit(text: string, file?: string): Promise<void> {
  if (file) {
    await fs.writeFile(file, text, 'utf-8');
    process.stderr.write(color.dim(`wrote ${file} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)\n`));
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function reportBatch(res: { stats: { ok: number; failed: number; cached: number; elapsedMs: number; costUsd: number; byTier: Record<string, number> } ; errors: { url: string; error: string }[] }, stats: boolean): void {
  if (res.errors.length) {
    process.stderr.write(color.yellow(`\n${res.errors.length} failed:\n`));
    for (const e of res.errors.slice(0, 10)) process.stderr.write(`  ${e.url}: ${e.error.split('\n')[0]}\n`);
  }
  if (stats) {
    const t = Object.entries(res.stats.byTier).map(([k, v]) => `${k}:${v}`).join(' ');
    process.stderr.write(color.dim(`\n${res.stats.ok} ok · ${res.stats.failed} failed · ${res.stats.cached} cached · ${t} · ${(res.stats.elapsedMs / 1000).toFixed(1)}s · $${res.stats.costUsd.toFixed(4)}\n`));
  }
}

async function saveImages(doc: import('./core/types.js').Document, dir: string): Promise<void> {
  const { fetchImages } = await import('./core/images.js');
  const path = await import('node:path');
  const r = await fetchImages(doc, { max: 50 });
  await fs.mkdir(dir, { recursive: true });
  const ext: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  for (const [i, img] of r.images.entries()) {
    const file = path.join(dir, `image-${String(i + 1).padStart(2, '0')}.${ext[img.mimeType] ?? 'img'}`);
    await fs.writeFile(file, Buffer.from(img.data, 'base64'));
    process.stderr.write(color.dim(`saved ${file} (${(img.bytes / 1024).toFixed(0)} KB)\n`));
  }
  for (const sk of r.skipped) process.stderr.write(color.yellow(`skipped ${sk.url}: ${sk.reason}\n`));
}

async function readStdinList(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

void Option;

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`${color.red('✗')} ${err.message}\n`);
  // `watch` follows diff(1): 0 unchanged, 1 changed, 2 trouble.
  process.exitCode = process.argv.includes('watch') ? 2 : 1;
});
