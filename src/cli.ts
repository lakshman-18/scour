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
import { Tier, type Document, type FetchOptions, type ScourConfig } from './core/types.js';

const program = new Command();
const logger = new ConsoleLogger('warn');

program
  .name('scour')
  .description('Give your agent eyes. Read and search anything on the internet — cheaply.')
  .version('0.5.0')
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
  .description('Fetch URLs or local files (PDF, Word, PowerPoint, Excel, EPUB, CSV…) and print clean Markdown')
  .argument('<urls...>', 'URLs or file paths to read (or - to read a list from stdin)')
  .option('-c, --comments [n]', 'include comments/replies (default: all available)')
  .option('--no-comments', 'skip comments')
  .option('--no-transcript', 'skip video transcripts')
  .option('-s, --selector <css>', 'extract only this CSS selector')
  .option('-f, --full', 'keep the whole page instead of the main article')
  .option('--max-tokens <n>', 'clip the body to roughly N tokens')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .option('--save-images <dir>', "download the page's images into this folder (to view, share, or hand to an AI)")
  .option('--structured', "print only the page's schema.org facts as JSON (price, rating, dates, ingredients…)")
  .option('--focus <question>', 'keep only the parts of the page about this question (saves tokens)')
  .option('--lang <code>', 'videos: transcript in this language (es, hi, fr…), using YouTube\'s translation if needed')
  .option('--frames <n>', 'videos: grab N key frames (slides, code, charts) to see what is on screen; needs ffmpeg')
  .option('--transcribe', 'videos/audio without captions: transcribe on this machine with Whisper (free)')
  .option('--keep-sponsors', 'videos: keep sponsor segments in the transcript (cut by default, via SponsorBlock)')
  .option('-a, --action <step...>', 'do this on the page first, in order: wait:1500 click:.more write:#q=hi press:Enter scroll screenshot js:…')
  .addHelpText('after', `
Examples:
  scour get ./deck.pptx                         a local file: PDF, Word, PowerPoint, Excel, EPUB, CSV, HTML
  scour get https://youtu.be/zjkBMFhNj_g --frames 6 --lang es   transcript in Spanish + 6 key frames
  scour get ./meeting.m4a                       transcribe audio or video on this machine (Whisper)
  scour get https://docs.example.com --focus "rate limits"
  scour get https://example.com/search -a "write:#q=scour" -a "press:Enter" -a "wait:#results"`)
  .action(async (urls: string[], cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const list = urls.includes('-') ? await readStdinList() : urls;
    const { parseAction } = await import('./core/actions.js');
    const actions = (cmdOpts.action as string[] | undefined)?.map(parseAction);
    const opts: FetchOptions = {
      ...fetchOptionsFrom(g),
      comments: cmdOpts.comments === true ? true : cmdOpts.comments === false ? false : cmdOpts.comments ? Number(cmdOpts.comments) : undefined,
      transcript: cmdOpts.transcript,
      adapterOptions: {
        selector: cmdOpts.selector, full: cmdOpts.full, ...(actions?.length ? { actions } : {}),
        ...(cmdOpts.lang ? { lang: cmdOpts.lang } : {}),
        ...(cmdOpts.frames ? { frames: Number(cmdOpts.frames) } : {}),
        ...(cmdOpts.transcribe ? { transcribe: true } : {}),
        ...(cmdOpts.keepSponsors ? { keepSponsors: true } : {}),
      },
    };
    const mediaOpts = { lang: cmdOpts.lang, frames: cmdOpts.frames ? Number(cmdOpts.frames) : 0 };
    const { isLocalFile, readLocalFile } = await import('./core/files.js');
    const { focusMarkdown } = await import('./core/focus.js');
    const readOne = async (input: string) => ((await isLocalFile(input)) ? readLocalFile(input, mediaOpts) : scour.get(input, opts));
    const focus = (d: Document) => {
      if (!cmdOpts.focus) return;
      const f = focusMarkdown(d.text, cmdOpts.focus);
      if (f.kept) {
        d.text = f.text;
        d.extra = { ...(d.extra ?? {}), focus: { question: cmdOpts.focus, kept: f.kept, of: f.total } };
      } else process.stderr.write(color.dim(`note: nothing in ${d.url} matched "${cmdOpts.focus}"; showing the whole page\n`));
    };

    if (list.length === 1) {
      const doc = await readOne(list[0]!);
      focus(doc);
      const shots = (doc.extra?.actions as { screenshots?: string[] } | undefined)?.screenshots ?? [];
      for (const [i, shot] of shots.entries()) {
        const file = `scour-action-${i + 1}.png`;
        await (await import('node:fs/promises')).writeFile(file, Buffer.from(shot.split(',')[1]!, 'base64'));
        process.stderr.write(color.dim(`saved screenshot ${file}\n`));
      }
      if (cmdOpts.structured) {
        await emit(JSON.stringify(doc.extra?.structured ?? [], null, 2));
        await scour.close();
        return;
      }
      if (cmdOpts.maxTokens) doc.text = clip(doc.text, Number(cmdOpts.maxTokens));
      const out = g.json ? JSON.stringify(slimDocument(doc, !!opts.comments), null, 2) : renderDocument(doc);
      await emit(out, cmdOpts.out);
      if (g.stats) process.stderr.write(`${color.dim(statsLine(doc))}\n`);
      const frameDir = cmdOpts.saveImages ?? (cmdOpts.frames && doc.media?.some((m) => m.url.startsWith('data:')) ? `frames-${slugify(doc.title ?? 'video')}` : undefined);
      if (frameDir) await saveImages(doc, frameDir);
      await scour.close();
      return;
    }

    const files: string[] = [];
    const webUrls: string[] = [];
    for (const x of list) ((await isLocalFile(x)) ? files : webUrls).push(x);
    const res = await batch(scour, webUrls, {
      ...opts,
      concurrency: g.concurrency ? Number(g.concurrency) : undefined,
      onProgress: (done, total, url, ok) =>
        g.verbose && process.stderr.write(`${ok ? color.green('✓') : color.red('✗')} ${done}/${total} ${url}\n`),
    });
    for (const f of files) {
      try {
        res.documents.push(await readLocalFile(f, mediaOpts));
      } catch (err) {
        res.errors.push({ url: f, error: (err as Error).message });
      }
    }
    for (const d of res.documents) {
      focus(d);
      if (cmdOpts.maxTokens) d.text = clip(d.text, Number(cmdOpts.maxTokens));
    }
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
  .argument('<query...>', 'words, plus: ToolMark (that spelling only), "exact phrase", -word (leave out), from:handle (one account)')
  .addHelpText('after', `
Examples:
  scour search "ToolMark" -s x                 only posts that spell it ToolMark
  scour search "ToolMark from:yourhandle" -s x  one account's posts (read directly, plus indexed ones)
  scour search "toolmark -forensic -firearm"    any spelling, minus a meaning you don't want
  scour me x yourhandle                         include your own recent posts in every X search`)
  .option('-s, --source <names>', 'one or more, comma-separated: reddit,hn,twitter,youtube,github,stackoverflow,wikipedia,bluesky,arxiv,npm,web')
  .option('-n, --limit <n>', 'results per source', '10')
  .option('--sort <order>', 'relevance (default) | engagement | recent')
  .option('--fetch', 'also fetch the full text of every result')
  .action(async (queryParts: string[], cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const query = queryParts.join(' ');
    const res = await scour.search(query, { ...fetchOptionsFrom(g), source: cmdOpts.source, limit: Number(cmdOpts.limit), sort: cmdOpts.sort });

    if (cmdOpts.fetch) {
      const b = await batch(scour, res.results.map((r) => r.url), fetchOptionsFrom(g));
      const out = g.json
        ? JSON.stringify({ query, documents: b.documents.map((d) => slimDocument(d, false)), errors: b.errors, stats: b.stats }, null, 2)
        : b.documents.map((d) => renderDocument(d)).join('\n\n---\n\n');
      await emit(out);
      reportBatch(b, g.stats);
    } else {
      await emit(g.json ? JSON.stringify(res, null, 2) : renderSearch(res.results));
      if (!g.json) for (const n of res.notes ?? []) process.stderr.write(`${color.dim(`note: ${n}`)}\n`);
      if (g.stats) process.stderr.write(`${color.dim(`${res.results.length} results · ${res.provenance.elapsedMs}ms · $${res.provenance.costUsd.toFixed(4)} · via ${res.provenance.strategy}`)}\n`);
    }
    await scour.close();
  });

// ---------------------------------------------------------------- research
program
  .command('research')
  .description('Search, read the best results in full, and build one cited Markdown pack for any AI')
  .argument('<question...>')
  .option('-s, --source <names>', 'comma-separated sources (default: all)')
  .option('-n, --limit <n>', 'documents to read in full', '8')
  .option('--per-doc <tokens>', 'clip each document to about this many tokens', '1500')
  .option('-o, --out <file>', 'write the pack to a file')
  .action(async (parts: string[], o, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { research } = await import('./workflows/research.js');
    const question = parts.join(' ');
    const pack = await research(scour, question, {
      ...fetchOptionsFrom(g), sources: o.source, limit: Number(o.limit), perDocTokens: Number(o.perDoc),
      onProgress: (stage, detail) => process.stderr.write(color.dim(`${stage}: ${detail}\n`)),
    });
    await emit(g.json ? JSON.stringify({ ...pack, documents: pack.documents.map((d) => slimDocument(d, false)) }, null, 2) : pack.markdown, o.out);
    process.stderr.write(color.dim(`${pack.stats.read} sources read in ${(pack.stats.elapsedMs / 1000).toFixed(1)}s from ${pack.stats.searched} · $${pack.stats.costUsd.toFixed(4)}\n`));
    if (pack.errors.length) process.stderr.write(color.yellow(`${pack.errors.length} result(s) could not be read\n`));
    await scour.close();
  });

// ---------------------------------------------------------------- track / insights
program
  .command('track')
  .description('Track a topic over time: collects posts and their likes/replies on every run (for `scour insights`)')
  .argument('[topics...]')
  .option('-s, --source <names>', 'comma-separated sources (default: x)', 'x')
  .option('-l, --list', 'list tracked topics')
  .option('--remove', 'stop tracking these topics')
  .option('--run', 'collect every tracked topic now (what the background service does)')
  .action(async (topics: string[], o, cmd) => {
    const g = cmd.parent.opts();
    const store = await import('./insights/store.js');
    if (o.list) {
      const all = await store.listTopics();
      if (!all.length) { console.log('No tracked topics. Add one: scour track "topic" -s x'); return; }
      for (const t of all) console.log(`${color.bold(t.query)} ${color.dim(`· ${t.sources} · ${t.posts} posts · ${t.runs} runs · last ${t.lastRunAt?.slice(0, 16).replace('T', ' ') ?? 'never'}`)}`);
      return;
    }
    if (o.remove) {
      for (const t of topics) console.log((await store.removeTopic(t, o.source.replace(/\bx\b/g, 'twitter'))) ? `Stopped tracking ${t}` : `Not tracked: ${t}`);
      return;
    }
    const { collect } = await import('./insights/collect.js');
    const scour = await makeScour(g);
    const targets = o.run ? (await store.listTopics()).map((t) => ({ q: t.query, s: t.sources })) : topics.map((q) => ({ q, s: o.source }));
    if (!targets.length) { program.error('track needs a topic, or --run / --list'); return; }
    for (const t of targets) {
      const r = await collect(scour, t.q, { sources: t.s });
      console.log(`${color.green('✓')} ${color.bold(t.q)} ${color.dim(`· ${r.posts.length} posts tracked · +${r.added} new · ${r.refreshed} re-checked · ${r.skippedOffTopic} off-topic skipped`)}`);
      for (const e of r.errors.slice(0, 3)) process.stderr.write(color.yellow(`  ! ${e}\n`));
    }
    await scour.close();
  });

program
  .command('insights')
  .description('What works for a topic: which formats, hooks and posts get traction, what is rising; compare topics')
  .argument('<topics...>')
  .option('-s, --source <names>', 'comma-separated sources (default: x)', 'x')
  .option('--no-refresh', 'analyse stored data only; do not collect first')
  .option('--days <n>', 'with several topics: compare over the last N days', '7')
  .option('-o, --out <file>', 'write the report to a file')
  .action(async (topics: string[], o, cmd) => {
    const g = cmd.parent.opts();
    const { collect } = await import('./insights/collect.js');
    const { loadTopic } = await import('./insights/store.js');
    const { analyze, compareTopics } = await import('./insights/analyze.js');
    const { renderInsights, renderComparison } = await import('./insights/render.js');
    const sources = o.source.replace(/\bx\b/g, 'twitter');
    const scour = await makeScour(g);
    const data: { topic: string; posts: import('./insights/analyze.js').TrackedPost[] }[] = [];
    for (const t of topics) {
      const stored = await loadTopic(t, sources);
      const stale = !stored?.topic.lastRunAt || Date.now() - Date.parse(stored.topic.lastRunAt) > 30 * 60_000;
      if (o.refresh && stale) {
        process.stderr.write(color.dim(`collecting ${t}…\n`));
        const r = await collect(scour, t, { sources });
        data.push({ topic: t, posts: r.posts });
      } else data.push({ topic: t, posts: stored?.posts ?? [] });
    }
    let text: string;
    if (topics.length > 1) {
      const rows = compareTopics(data, Date.now(), Number(o.days));
      text = g.json ? JSON.stringify(rows, null, 2) : renderComparison(rows, Number(o.days));
    } else {
      const report = analyze(topics[0]!, data[0]!.posts);
      text = g.json ? JSON.stringify(report, null, 2) : renderInsights(report);
    }
    await emit(text, o.out);
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
  .option('--jsonl', 'stream one JSON document per line to stdout as each page arrives')
  .option('--state <file>', 'save progress here; run the same command again to resume an interrupted crawl')
  .action(async (url: string, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const stream = !!cmdOpts.jsonl;
    const res = await crawl(scour, url, {
      statePath: cmdOpts.state,
      ...fetchOptionsFrom(g),
      depth: Number(cmdOpts.depth),
      limit: Number(cmdOpts.limit),
      sameHost: !cmdOpts.allHosts,
      include: cmdOpts.include ? new RegExp(cmdOpts.include) : undefined,
      exclude: cmdOpts.exclude ? new RegExp(cmdOpts.exclude) : undefined,
      useSitemap: cmdOpts.sitemap,
      respectRobots: cmdOpts.robots,
      concurrency: g.concurrency ? Number(g.concurrency) : undefined,
      onPage: (doc, depth, queued) => {
        if (stream) process.stdout.write(`${JSON.stringify(slimDocument(doc, false))}\n`);
        if (g.verbose) process.stderr.write(`${color.green('✓')} d${depth} q${queued} ${doc.url}\n`);
      },
    });
    if (stream) {
      process.stderr.write(color.dim(`crawled ${res.stats.visited} pages in ${(res.stats.elapsedMs / 1000).toFixed(1)}s\n`));
      await scour.close();
      return;
    }
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
  .option('--search <query>', 'watch a topic instead of a URL: alert on results that have never appeared before')
  .option('-s, --source <names>', 'with --search: comma-separated sources (default: all)')
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
        console.log(`${color.bold(w.label ?? w.url)}\n  ${color.cyan(w.search ? `topic search · ${w.search.sources ?? 'all sources'}` : w.url)}\n  ${color.dim(`${w.runs} runs · last change ${w.lastChangedAt.slice(0, 16).replace('T', ' ')}${alerts.length ? ` · alerts: ${alerts.join(', ')}` : ''}`)}`);
      }
      return;
    }
    if (cmdOpts.clear) { console.log(`Removed ${await clearWatches()} watches.`); return; }
    if (cmdOpts.remove) {
      const { searchKey } = await import('./workflows/watch.js');
      const target = cmdOpts.search ? searchKey(cmdOpts.search, cmdOpts.source) : url;
      if (!target) { program.error('watch --remove needs a URL or --search'); return; }
      console.log((await removeWatch(target)) ? `Stopped watching ${cmdOpts.search ?? url}` : `No watch found for ${cmdOpts.search ?? url}`);
      return;
    }
    if (!url && !cmdOpts.all && !cmdOpts.search) { program.error('watch needs a URL, --search "topic", or --all / --list'); return; }

    const scour = await makeScour(g);
    const runOnce = async (): Promise<number> => {
      const { watchSearch } = await import('./workflows/watch.js');
      const results = cmdOpts.all
        ? await watchAll(scour, { ...fetchOptionsFrom(g) })
        : cmdOpts.search
          ? [await watchSearch(scour, cmdOpts.search, { ...fetchOptionsFrom(g), sources: cmdOpts.source, label: cmdOpts.label, reset: cmdOpts.reset, notify: cliNotify })]
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
    process.stderr.write(color.dim(`watching ${cmdOpts.all ? 'all registered watches' : cmdOpts.search ? `“${cmdOpts.search}”` : url} every ${cmdOpts.every} · Ctrl-C to stop\n`));
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
  .description('Pull structured data out of a page: by example (no selectors needed), with a saved rule, or with CSS selectors')
  .argument('<url>')
  .option('-e, --example <value...>', 'a value you can see on the page; scour finds every similar one (name=value for several fields)')
  .option('--save <name>', 'save what was learned as a reusable rule')
  .option('-r, --rule <name>', 'run a saved rule (it repairs itself if the site changed)')
  .option('-f, --field <name=selector...>', 'field mapping with CSS selectors, e.g. price=.price title=h1')
  .option('--list <selector>', 'repeat the fields for every element matching this')
  .option('--attr <name>', 'read this attribute instead of the text', '')
  .option('--csv', 'print CSV instead of JSON (opens in Excel / Sheets)')
  .addHelpText('after', `
Examples:
  scour extract https://news.ycombinator.com -e "title=<a headline you see>" -e "points=123 points" --save hn
  scour extract https://news.ycombinator.com --rule hn --csv > hn.csv
  scour extract https://shop.example.com -f "title=h1" -f "price=.price"`)
  .action(async (url: string, cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const out = async (records: Record<string, string | null>[], meta: Record<string, unknown>) => {
      if (cmdOpts.csv) await emit(toCsv(records));
      else await emit(JSON.stringify({ ...meta, count: records.length, records }, null, 2));
    };

    if (cmdOpts.example?.length) {
      const { learn, saveRule } = await import('./workflows/learn.js');
      const r = await learn(scour, url, cmdOpts.example as string[], fetchOptionsFrom(g));
      if (!Object.keys(r.rule.fields).length) {
        program.error(`None of the examples were found on the page${r.tier === 'headless' ? '' : ' (also tried rendering it)'}: ${r.missing.map((m) => `"${m}"`).join(', ')}`);
      }
      if (r.missing.length) process.stderr.write(color.dim(`note: not found on the page: ${r.missing.map((m) => `"${m}"`).join(', ')}\n`));
      const sel = [r.rule.list ? `--list "${r.rule.list}"` : '', ...Object.entries(r.rule.fields).map(([k, v]) => `-f "${k}=${v}"`)].filter(Boolean).join(' ');
      process.stderr.write(color.dim(`learned: ${sel}\n`));
      if (cmdOpts.save) process.stderr.write(color.dim(`saved rule "${cmdOpts.save}": ${await saveRule(cmdOpts.save, r.rule)}\n`));
      await out(r.records, { url, learned: { list: r.rule.list, fields: r.rule.fields }, tier: r.tier });
    } else if (cmdOpts.rule) {
      const { loadRule, runRule, saveRule } = await import('./workflows/learn.js');
      const rule = await loadRule(cmdOpts.rule);
      const r = await runRule(scour, url, rule, fetchOptionsFrom(g));
      if (r.repaired) {
        await saveRule(cmdOpts.rule, r.repaired.rule);
        process.stderr.write(color.dim(`note: the page changed and the old selectors found nothing; relocated the items by similarity (${Math.round(r.repaired.score * 100)}% match) and updated rule "${cmdOpts.rule}"\n`));
      }
      if (!r.records.length) process.stderr.write(color.dim(`note: rule "${cmdOpts.rule}" found nothing on this page and no similar structure was found\n`));
      await out(r.records, { url: r.url, rule: cmdOpts.rule, repaired: !!r.repaired, tier: r.tier });
    } else {
      if (!cmdOpts.field?.length) program.error('Give --example "<a value on the page>", --rule <name>, or -f name=selector');
      const { extractStructured } = await import('./workflows/extract.js');
      const fields: Record<string, string> = {};
      for (const f of cmdOpts.field as string[]) {
        const i = f.indexOf('=');
        if (i < 1) program.error(`--field must be name=selector, got "${f}"`);
        fields[f.slice(0, i)] = f.slice(i + 1);
      }
      const data = await extractStructured(scour, url, { fields, list: cmdOpts.list, attr: cmdOpts.attr || undefined, options: fetchOptionsFrom(g) });
      if (cmdOpts.csv) await emit(toCsv(data.records));
      else await emit(JSON.stringify(data, null, 2));
    }
    await scour.close();
  });

program
  .command('rules')
  .description('List the extraction rules saved with scour extract --save')
  .action(async () => {
    const { listRules } = await import('./workflows/learn.js');
    const rules = await listRules();
    if (!rules.length) console.log('No saved rules. Make one: scour extract <url> --example "<a value on the page>" --save <name>');
    for (const r of rules) {
      console.log(`${r.name}  ${Object.keys(r.fields).join(', ')}  learned on ${r.url}${r.repairedAt ? ` (repaired ${r.repairedAt.slice(0, 10)})` : ''}`);
    }
  });

/** Records → CSV with quoting, for spreadsheets. */
function toCsv(records: Record<string, string | null>[]): string {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const q = (v: string | null | undefined) => (v === null || v === undefined ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...records.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}

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
  .option('--allow-private', 'allow fetching private/loopback addresses (disables the SSRF guard)')
  .action(async (cmdOpts, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { startServer } = await import('./server/serve.js');
    const srv = await startServer(scour, {
      port: Number(cmdOpts.port),
      host: cmdOpts.host,
      apiKey: cmdOpts.apiKey ?? process.env.SCOUR_API_KEY,
      allowPrivate: !!cmdOpts.allowPrivate,
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

// ---------------------------------------------------------------- service
const serviceCmd = program
  .command('service')
  .description('Background service: runs watches and tracked topics on a schedule and sends one daily digest');

serviceCmd
  .command('install')
  .description('Start the background service (macOS LaunchAgent; prints a crontab line elsewhere)')
  .option('--every <minutes>', 'check watches every N minutes', '30')
  .option('--track-every <minutes>', 'refresh tracked topics every N minutes (uses search quota)', '180')
  .option('--digest <HH:MM>', 'daily digest time, local 24-hour; "off" to disable', '08:00')
  .option('-n, --notify <target...>', 'digest destinations (default: macos). Same targets as watch --notify')
  .action(async (o) => {
    const svc = await import('./service/service.js');
    const r = await svc.install({
      everyMinutes: Number(o.every), trackEveryMinutes: Number(o.trackEvery),
      digestAt: o.digest === 'off' ? '' : o.digest, notify: o.notify,
    });
    if (r.how === 'cron') { console.log(r.detail); return; }
    const st = await svc.status();
    console.log(`${color.green('✓')} background service ${st.loaded ? 'running' : 'installed'} (${r.detail})`);
    console.log(color.dim(`  watches every ${st.config.everyMinutes} min · topics every ${st.config.trackEveryMinutes} min · digest ${st.config.digestAt || 'off'} → ${st.config.notify.join(', ') || 'file only'}`));
    console.log(color.dim(`  ${st.watches} watches, ${st.topics} tracked topics · logs: scour service logs · stop: scour service uninstall`));
  });

serviceCmd.command('uninstall').description('Stop and remove the background service').action(async () => {
  const svc = await import('./service/service.js');
  console.log((await svc.uninstall()) ? 'Background service stopped and removed.' : 'No background service was installed.');
});

serviceCmd.command('status').description('Is it running, when is the next digest, recent activity').action(async () => {
  const svc = await import('./service/service.js');
  const st = await svc.status();
  console.log(`${st.loaded ? color.green('● running') : st.installed ? color.yellow('◐ installed, not loaded') : color.dim('○ not installed')}`);
  console.log(`watches every ${st.config.everyMinutes} min · topics every ${st.config.trackEveryMinutes} min · ${st.watches} watches · ${st.topics} topics`);
  console.log(`digest: ${st.config.digestAt ? `${st.config.digestAt} daily → ${st.config.notify.map((n) => { try { const p = parseNotifySafe(n); return p; } catch { return n; } }).join(', ') || 'file only'} · next ${st.nextDigest?.slice(0, 16).replace('T', ' ')} UTC` : 'off'}`);
  console.log(`last run: ${st.config.lastTickAt?.slice(0, 16).replace('T', ' ') ?? 'never'} UTC · last digest: ${st.config.lastDigestAt?.slice(0, 16).replace('T', ' ') ?? 'never'} UTC`);
  if (st.recentLog.filter(Boolean).length) console.log(color.dim(`\n${st.recentLog.join('\n')}`));
});

serviceCmd
  .command('tick')
  .description('Run one scheduled pass now (what the service runs)')
  .option('--digest', 'send the digest now regardless of time')
  .option('--track', 'refresh tracked topics now regardless of schedule')
  .action(async (o, cmd) => {
    const g = cmd.parent.parent.opts();
    const svc = await import('./service/service.js');
    const scour = await makeScour({ ...g, quiet: true });
    for (const line of await svc.tick(scour, { forceDigest: !!o.digest, forceTrack: !!o.track })) console.log(line);
    await scour.close();
  });

serviceCmd.command('digest').description('Print what the next digest would contain, without sending it').action(async () => {
  const svc = await import('./service/service.js');
  const cfg = await svc.readServiceConfig();
  console.log((await svc.buildDigest(cfg.lastDigestAt)).markdown);
});

serviceCmd.command('logs').description('Show recent service log lines').action(async () => {
  const svc = await import('./service/service.js');
  const st = await svc.status();
  console.log(st.recentLog.join('\n') || 'No log yet.');
});

function parseNotifySafe(spec: string): string {
  return spec.startsWith('macos') ? 'macOS notification' : spec.replace(/(https?:\/\/[^/]+)\/.*/, '$1/…');
}

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

// ---------------------------------------------------------------- ui
program
  .command('ui')
  .description('Open the local web app: read, search, research, watches and trend insights in your browser')
  .option('-p, --port <n>', 'port', '3003')
  .option('--no-open', 'do not open the browser')
  .action(async (o, cmd) => {
    const g = cmd.parent.opts();
    const scour = await makeScour(g);
    const { startServer } = await import('./server/serve.js');
    const srv = await startServer(scour, { port: Number(o.port), host: '127.0.0.1', ui: true });
    process.stderr.write(`${color.green('●')} scour is open at ${color.bold(srv.url)} ${color.dim('(this Mac only · Ctrl-C to stop)')}\n`);
    if (o.open) {
      const { execFile } = await import('node:child_process');
      execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [srv.url], () => {});
    }
    const stop = async () => { await srv.close(); await scour.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
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
    console.log(color.dim(`headless: ${(await isRenderAvailable()) ? 'playwright available (browsers: npx playwright install chromium)' : 'not available — npx playwright install chromium, for JS-only pages and screenshots'}`));
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

// ---------------------------------------------------------------- me
program
  .command('me')
  .description('Your own accounts: X searches then include your recent posts (read from your public timeline, free)')
  .argument('[platform]', 'x')
  .argument('[handle]', 'your handle (with or without @), or a link to any of your posts')
  .option('--remove', 'forget this account')
  .action(async (platform: string | undefined, handle: string | undefined, o, cmd) => {
    const { listArchives } = await import('./adapters/x-archive.js');
    if (platform && !['x', 'twitter'].includes(platform.toLowerCase())) { program.error('Only X accounts for now: scour me x <handle>'); return; }
    if (platform && handle) {
      const scour = await makeScour(cmd.parent.opts());
      const { addMyAccount } = await import('./workflows/me.js');
      const r = await addMyAccount(scour, handle, !!o.remove);
      console.log(r.message);
      if (r.accounts.length) console.log(color.dim(`Your X accounts: ${r.accounts.map((h) => `@${h}`).join(', ')}`));
      await scour.close();
      return;
    }
    const cfg = await loadConfig();
    const archives = await listArchives();
    const xs = cfg.accounts?.x ?? [];
    console.log(xs.length ? `X: ${xs.map((h) => `@${h}`).join(', ')}` : 'No accounts saved. Add yours: scour me x <handle>');
    for (const a of archives) {
      console.log(`  archive: @${a.handle}, ${a.posts.length} posts, ${a.posts.at(-1)?.createdAt?.slice(0, 10) ?? '?'} → ${a.posts[0]?.createdAt?.slice(0, 10) ?? '?'} (imported ${a.importedAt.slice(0, 10)})`);
    }
    if (!archives.length) console.log(color.dim('For your full history, not just the latest posts: scour import x-archive <the .zip X sends you>'));
  });

// ---------------------------------------------------------------- login
program
  .command('login')
  .description('Log in to a site yourself in a browser window, so scour can read what you see logged in (X replies, live search…)')
  .argument('[site]', 'x, reddit, linkedin, instagram, threads, or any domain; omit to list saved logins')
  .option('--timeout <minutes>', 'how long to wait for you to finish logging in', '10')
  .action(async (site: string | undefined, o) => {
    const { listSessions, siteFor, sessionDir, writeMeta } = await import('./render/sessions.js');
    if (!site) {
      const all = await listSessions();
      if (!all.length) console.log('No saved logins. Add one: scour login x');
      for (const s of all) console.log(`${s.site}  saved ${s.savedAt.slice(0, 10)}${s.channel ? ' (Google Chrome)' : ''}`);
      return;
    }
    const info = siteFor(site);
    const { loginInteractive } = await import('./render/browser.js');
    console.log(`Opening ${info.loginUrl} in a browser window.`);
    console.log('Log in there yourself: scour never sees your password, and the session stays on this Mac (~/.scour/sessions).');
    console.log(color.dim(
      'Reading a site as a logged-in account can break its rules and get the account limited. Use an account you can afford to lose,\n' +
      'and keep the pace human: scour reads one page at a time.',
    ));
    console.log(info.loggedInCookie ? 'The window closes by itself once you are logged in.' : 'Close the window when you are logged in.');
    const r = await loginInteractive(sessionDir(info.key), info.loginUrl, {
      hosts: info.hosts, loggedInCookie: info.loggedInCookie, timeoutMs: Number(o.timeout) * 60_000,
    });
    await writeMeta(info.key, { site: info.key, savedAt: new Date().toISOString(), channel: r.channel, loggedIn: r.loggedIn });
    if (r.loggedIn) {
      console.log(`${color.green('✓')} Logged in to ${info.key}. scour now reads it as you${info.key === 'x' ? ': replies, live search and current profiles' : ''}.`);
      console.log(color.dim(`Undo any time: scour logout ${info.key}`));
    } else {
      console.log(`${color.red('✗')} No login detected for ${info.key}, so nothing will use it. Run scour login ${site} again when ready.`);
      process.exitCode = 1;
    }
  });

program
  .command('logout')
  .description('Delete a saved login (the whole browser profile scour kept for that site)')
  .argument('<site>')
  .action(async (site: string) => {
    const { removeSession, siteFor } = await import('./render/sessions.js');
    const key = siteFor(site).key;
    console.log((await removeSession(key)) ? `Deleted the saved ${key} login.` : `No saved ${key} login.`);
  });

// ---------------------------------------------------------------- import
const importCmd = program.command('import').description('Bring your own data in, for complete and free search');
importCmd
  .command('x-archive')
  .description('Import the archive X lets you download (Settings → Your account → Download an archive of your data)')
  .argument('<path>', 'the .zip, or the folder it unpacks to')
  .action(async (source: string) => {
    const { importXArchive } = await import('./adapters/x-archive.js');
    const { saveAccount } = await import('./core/config.js');
    const { archive, file } = await importXArchive(source);
    await saveAccount('x', archive.handle);
    if (archive.accountId) {
      // The archive knows your account id, so timeline reads can skip the by-name lookup.
      const cfg = await loadConfig();
      await new FileCache(cfg.cacheDir).set(`x:uid:${archive.handle.toLowerCase()}`, archive.accountId, 90 * 86_400);
    }
    const replies = archive.posts.filter((p) => p.replyTo).length;
    console.log(`Imported @${archive.handle}: ${archive.posts.length} posts (${replies} replies), ` +
      `${archive.posts.at(-1)?.createdAt?.slice(0, 10) ?? '?'} → ${archive.posts[0]?.createdAt?.slice(0, 10) ?? '?'}.`);
    console.log(color.dim(`Stored in ${file} (only posts and their counts; nothing else from the archive is kept).`));
    console.log(`X searches now include your whole history, e.g. scour search "ToolMark" -s x`);
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

// Long-running commands manage their own lifetime; everything else must exit
// promptly even if a headless browser or a keep-alive socket is still open.
const LONG_RUNNING = new Set(['serve', 'mcp', 'ui']);
const command = process.argv.slice(2).find((a) => !a.startsWith('-'));
const longRunning = (command && LONG_RUNNING.has(command)) || process.argv.includes('--every');

async function shutdown(code?: number): Promise<void> {
  const { closeBrowser } = await import('./render/browser.js');
  await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 3000))]);
  if (code !== undefined) process.exitCode = code;
  // A lingering browser process or socket must never keep a one-shot CLI alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}

program
  .parseAsync(process.argv)
  .then(() => {
    if (!longRunning) return shutdown();
  })
  .catch(async (err: Error) => {
    process.stderr.write(`${color.red('✗')} ${err.message}\n`);
    // `watch` follows diff(1): 0 unchanged, 1 changed, 2 trouble.
    await shutdown(process.argv.includes('watch') ? 2 : 1);
  });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
}
