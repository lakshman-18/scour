import { actionsFromFirecrawl } from '../core/actions.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Scour } from '../core/pipeline.js';
import type { Document, FetchOptions } from '../core/types.js';
import { batch } from '../workflows/batch.js';
import { crawl } from '../workflows/crawl.js';
import { map } from '../workflows/map.js';
import { watch } from '../workflows/watch.js';
import { extractStructured } from '../workflows/extract.js';
import { assertPublicUrl, BlockedTarget } from './ssrf.js';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

/**
 * Local HTTP API.
 *
 * Speaks Firecrawl's protocol (v1 and v2) so anything already built for
 * Firecrawl — n8n nodes, LangChain loaders, Dify, the official SDKs — works by
 * pointing its base URL here. Native /scour/* routes expose the rest.
 *
 * Binds to 127.0.0.1 by default. Exposing it beyond localhost requires an API
 * key, because this server will fetch any URL it is asked to.
 */
export interface ServeOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  /** Allow fetching private/loopback addresses (off by default: SSRF guard). */
  allowPrivate?: boolean;
  /** Serve the local web app at / (scour ui). */
  ui?: boolean;
  log?: (line: string) => void;
}

type Json = Record<string, unknown>;
type Format = 'markdown' | 'html' | 'rawHtml' | 'links' | 'screenshot' | 'json' | 'summary' | string;

interface Job {
  id: string;
  kind: 'crawl' | 'batch';
  version: 'v1' | 'v2';
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  data: Json[];
  error?: string;
  createdAt: number;
  controller: AbortController;
}

const JOB_TTL_MS = 24 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;

export async function startServer(scour: Scour, opts: ServeOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const port = opts.port ?? 3002; // Firecrawl's self-host default, so existing configs just work
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
  const jobs = new Map<string, Job>();
  const publicBase = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  if (!isLoopback(host) && !opts.apiKey) {
    throw new Error(`Refusing to listen on ${host} without an API key. Set SCOUR_API_KEY or pass --api-key.`);
  }
  // Saved logins are yours alone: a server other machines can reach never uses them.
  if (!isLoopback(host)) process.env.SCOUR_NO_SESSIONS = '1';

  // Expired jobs are dropped hourly so a long-running server can't leak memory.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }, 3600_000);
  sweeper.unref();

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', publicBase);
    try {
      // DNS rebinding: a loopback server must only answer to loopback names.
      if (isLoopback(host) && !isLoopbackHost(req.headers.host ?? '')) {
        return send(res, 421, { success: false, error: 'Misdirected request' });
      }
      // CSRF: a browser page on another site must not drive this server.
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && new URL(origin).host !== req.headers.host) {
        return send(res, 403, { success: false, error: 'Cross-origin requests are not allowed' });
      }
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (opts.ui && req.method === 'GET' && (await serveUi(url.pathname, res))) return;
      if (url.pathname === '/health' || url.pathname === '/') {
        return send(res, 200, { ok: true, name: 'scour', firecrawlCompatible: ['v1', 'v2'] });
      }
      if (!authorized(req, opts.apiKey)) return send(res, 401, { success: false, error: 'Unauthorized: bad or missing API key' });

      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
      const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
      if (!opts.allowPrivate) {
        const targets = [
          body.url, url.searchParams.get('url'),
          ...(Array.isArray(body.urls) ? (body.urls as unknown[]) : []),
        ].filter((x): x is string => typeof x === 'string' && x.length > 0);
        for (const t of targets) await assertPublicUrl(t);
      }
      const m = /^\/(v1|v2)\/(crawl|batch\/scrape)\/([\w-]+)$/.exec(url.pathname);

      // ------------------------------------------------ Firecrawl-compatible
      if (route === 'POST /v1/scrape' || route === 'POST /v2/scrape') {
        const doc = await scour.get(String(body.url ?? ''), scrapeOptions(body));
        return send(res, 200, { success: true, data: await toFirecrawl(scour, doc, formatsOf(body), body) });
      }

      if (route === 'POST /v1/map' || route === 'POST /v2/map') {
        const r = await map(scour, String(body.url ?? ''), {
          search: body.search as string | undefined,
          limit: num(body.limit),
          includeSubdomains: !!body.includeSubdomains,
          ignoreSitemap: body.ignoreSitemap === true || body.sitemap === 'skip',
        });
        const links = url.pathname.startsWith('/v2')
          ? r.links.map((l) => ({ url: l.url, title: l.title }))
          : r.links.map((l) => l.url);
        return send(res, 200, { success: true, links });
      }

      if (route === 'POST /v1/search' || route === 'POST /v2/search') {
        const limit = num(body.limit) ?? 5;
        const r = await scour.search(String(body.query ?? ''), { source: 'websearch', limit });
        let items: Json[] = r.results.map((x, i) => ({ url: x.url, title: x.title, description: x.snippet ?? '', position: i + 1 }));
        const so = (body.scrapeOptions ?? {}) as Json;
        if (formatsOf(so).length) {
          const b = await batch(scour, r.results.map((x) => x.url), { comments: false });
          const byUrl = new Map(b.documents.map((d) => [d.url, d]));
          items = await Promise.all(items.map(async (it) => {
            const d = byUrl.get(it.url as string) ?? b.documents.find((x) => x.provenance.finalUrl === it.url);
            return d ? { ...it, ...(await toFirecrawl(scour, d, formatsOf(so), so)) } : it;
          }));
        }
        return send(res, 200, url.pathname.startsWith('/v2') ? { success: true, data: { web: items } } : { success: true, data: items });
      }

      if (route === 'POST /v1/crawl' || route === 'POST /v2/crawl') {
        const version = url.pathname.slice(1, 3) as 'v1' | 'v2';
        const job = newJob('crawl', version);
        jobs.set(job.id, job);
        const so = (body.scrapeOptions ?? {}) as Json;
        const include = regexList(body.includePaths);
        const exclude = regexList(body.excludePaths);
        const pending: Promise<void>[] = [];
        void crawl(scour, String(body.url ?? ''), {
          ...scrapeOptions(so),
          signal: job.controller.signal,
          limit: num(body.limit) ?? 10,
          depth: num(body.maxDepth) ?? num(body.maxDiscoveryDepth) ?? 2,
          sameHost: body.allowExternalLinks !== true,
          include, exclude,
          onPage: (doc) => {
            if (job.status !== 'scraping') return;
            job.completed++;
            job.total = Math.max(job.total, job.completed);
            pending.push(toFirecrawl(scour, doc, formatsOf(so), so).then((d) => void job.data.push(d)));
          },
        })
          .then(async (r) => {
            await Promise.all(pending); // never report "completed" with pages still converting
            if (job.status === 'scraping') job.status = 'completed';
            job.total = r.stats.visited;
          })
          .catch((err: Error) => {
            job.status = 'failed';
            job.error = err.message;
          });
        return send(res, 200, { success: true, id: job.id, url: `${publicBase}/${version}/crawl/${job.id}` });
      }

      if (route === 'POST /v1/batch/scrape' || route === 'POST /v2/batch/scrape') {
        const version = url.pathname.slice(1, 3) as 'v1' | 'v2';
        const urls = Array.isArray(body.urls) ? (body.urls as string[]) : [];
        const job = newJob('batch', version);
        job.total = urls.length;
        jobs.set(job.id, job);
        void batch(scour, urls, {
          ...scrapeOptions(body),
          signal: job.controller.signal,
          onProgress: () => {
            job.completed++;
          },
        })
          .then(async (r) => {
            job.data = await Promise.all(r.documents.map((d) => toFirecrawl(scour, d, formatsOf(body), body)));
            job.status = 'completed';
          })
          .catch((err: Error) => {
            job.status = 'failed';
            job.error = err.message;
          });
        return send(res, 200, { success: true, id: job.id, url: `${publicBase}/${version}/batch/scrape/${job.id}` });
      }

      if (m && req.method === 'GET') {
        const job = jobs.get(m[3]!);
        if (!job) return send(res, 404, { success: false, error: 'Job not found or expired' });
        return send(res, 200, {
          success: true,
          status: job.status,
          total: job.total,
          completed: job.completed,
          creditsUsed: 0,
          expiresAt: new Date(job.createdAt + JOB_TTL_MS).toISOString(),
          data: job.data,
          ...(job.error ? { error: job.error } : {}),
        });
      }

      if (m && req.method === 'DELETE') {
        const job = jobs.get(m[3]!);
        if (!job) return send(res, 404, { success: false, error: 'Job not found or expired' });
        job.status = 'cancelled';
        job.controller.abort();
        return send(res, 200, { success: true, status: 'cancelled' });
      }

      // ------------------------------------------------ native scour routes
      if (route === 'GET /scour/get' || route === 'POST /scour/get') {
        const target = (body.url as string) ?? url.searchParams.get('url') ?? '';
        const comments = (body.comments as boolean | undefined) ?? url.searchParams.get('comments') !== 'false';
        return send(res, 200, await scour.get(target, { comments }));
      }
      if (route === 'GET /scour/search' || route === 'POST /scour/search') {
        const q = (body.query as string) ?? url.searchParams.get('q') ?? '';
        const source = (body.source as string) ?? url.searchParams.get('source') ?? undefined;
        const limit = num(body.limit) ?? num(url.searchParams.get('limit')) ?? 10;
        const sort = ((body.sort as string) ?? url.searchParams.get('sort') ?? undefined) as 'relevance' | 'engagement' | 'recent' | undefined;
        return send(res, 200, await scour.search(q, { source: source || undefined, limit, sort }));
      }
      if (route === 'POST /scour/watch') {
        const r = await watch(scour, String(body.url ?? ''), { label: body.label as string | undefined });
        return send(res, 200, { ...r, document: slim(r.document) });
      }
      if (route === 'POST /scour/extract') {
        return send(res, 200, await extractStructured(scour, String(body.url ?? ''), {
          fields: (body.fields ?? {}) as Record<string, string>,
          list: body.list as string | undefined,
        }));
      }
      if (route === 'GET /scour/doctor') return send(res, 200, await scour.health());

      // ------------------------------------------------ web app routes
      if (route === 'POST /scour/research') {
        const { research } = await import('../workflows/research.js');
        const pack = await research(scour, String(body.question ?? ''), {
          sources: (body.sources as string | undefined) || undefined, limit: num(body.limit) ?? 6, perDocTokens: 1500,
        });
        return send(res, 200, { ...pack, documents: undefined });
      }
      if (route === 'GET /scour/watches') {
        const { listWatches } = await import('../workflows/watch.js');
        const { parseNotify, redact } = await import('../workflows/notify.js');
        const all = await listWatches();
        return send(res, 200, all.map((w) => ({
          label: w.label ?? null, url: w.url, search: w.search ?? null, runs: w.runs,
          lastSeenAt: w.lastSeenAt, lastChangedAt: w.lastChangedAt, items: w.seenIds.length,
          alerts: (w.notify ?? []).map((n) => { try { const x = parseNotify(n); return x.kind === 'macos' || x.kind === 'ntfy' ? `${x.kind} ${x.target}` : `${x.kind} ${redact(x.target)}`; } catch { return 'invalid'; } }),
        })));
      }
      if (route === 'POST /scour/watch/search') {
        const { watchSearch } = await import('../workflows/watch.js');
        const r = await watchSearch(scour, String(body.search ?? ''), { sources: (body.sources as string) || undefined, label: body.label as string | undefined });
        return send(res, 200, { ...r, document: undefined });
      }
      if (route === 'POST /scour/watch/remove') {
        const { removeWatch, searchKey } = await import('../workflows/watch.js');
        const key = body.search ? searchKey(String(body.search), (body.sources as string) || undefined) : String(body.url ?? '');
        return send(res, 200, { removed: await removeWatch(key) });
      }
      if (route === 'POST /scour/watch/all') {
        const { watchAll } = await import('../workflows/watch.js');
        const rs = await watchAll(scour, {});
        return send(res, 200, rs.map((r) => ({ ...r, document: undefined })));
      }
      if (route === 'GET /scour/topics') {
        const { listTopics } = await import('../insights/store.js');
        return send(res, 200, await listTopics());
      }
      if (route === 'POST /scour/track') {
        const { collect } = await import('../insights/collect.js');
        const r = await collect(scour, String(body.topic ?? ''), { sources: srcOf(body.sources) });
        return send(res, 200, { topic: r.topic, posts: r.posts.length, added: r.added, refreshed: r.refreshed, skippedOffTopic: r.skippedOffTopic, errors: r.errors });
      }
      if (route === 'POST /scour/track/remove') {
        const { removeTopic } = await import('../insights/store.js');
        return send(res, 200, { removed: await removeTopic(String(body.topic ?? ''), srcOf(body.sources)) });
      }
      if (route === 'POST /scour/insights') {
        const { collect } = await import('../insights/collect.js');
        const { loadTopic } = await import('../insights/store.js');
        const { analyze, compareTopics } = await import('../insights/analyze.js');
        const topics = Array.isArray(body.topics) ? (body.topics as string[]).filter(Boolean).slice(0, 6) : [];
        if (!topics.length) throw new Error('Unknown source: give at least one topic');
        const sources = srcOf(body.sources);
        const days = num(body.days) ?? 7;
        const data = [];
        for (const t of topics) {
          const stored = await loadTopic(t, sources);
          const stale = !stored?.topic.lastRunAt || Date.now() - Date.parse(stored.topic.lastRunAt) > 30 * 60_000;
          data.push(body.refresh === true && stale ? { topic: t, posts: (await collect(scour, t, { sources })).posts } : { topic: t, posts: stored?.posts ?? [] });
        }
        return send(res, 200, topics.length > 1
          ? { mode: 'compare', days, rows: compareTopics(data, Date.now(), days) }
          : { mode: 'single', report: analyze(topics[0]!, data[0]!.posts) });
      }
      if (route === 'GET /scour/status') {
        const svc = await import('../service/service.js');
        const { usageSummary } = await import('../core/usage.js');
        const { FileCache } = await import('../core/cache.js');
        return send(res, 200, {
          service: await svc.status(),
          usage: await usageSummary(),
          cache: await new FileCache(scour.config.cacheDir).stats(),
          spentUsd: scour.budget.spentUsd,
          providers: { tavily: !!scour.config.providers.tavilyKey, brave: !!scour.config.providers.braveKey, xApi: !!scour.config.providers.xBearerToken },
        });
      }
      if (route === 'GET /scour/me' || route === 'POST /scour/me') {
        const { listArchives } = await import('../adapters/x-archive.js');
        let message: string | undefined;
        if (route === 'POST /scour/me') {
          const { addMyAccount } = await import('../workflows/me.js');
          const r = await addMyAccount(scour, String(body.handle ?? ''), body.remove === true);
          if (!r.ok) return send(res, 400, { success: false, error: r.message });
          message = r.message;
        }
        const archives = (await listArchives()).map((a) => ({
          handle: a.handle, posts: a.posts.length, importedAt: a.importedAt,
          from: a.posts.at(-1)?.createdAt, to: a.posts[0]?.createdAt,
        }));
        return send(res, 200, { x: scour.config.accounts?.x ?? [], archives, message });
      }
      if (route === 'GET /scour/digest') {
        const svc = await import('../service/service.js');
        const cfg = await svc.readServiceConfig();
        return send(res, 200, await svc.buildDigest(cfg.lastDigestAt));
      }

      return send(res, 404, { success: false, error: `No route for ${req.method} ${url.pathname}` });
    } catch (err) {
      const msg = (err as Error).message;
      const status = err instanceof BlockedTarget ? 403 : /Not a usable URL|must be|Unknown source|Invalid JSON/.test(msg) ? 400 : 500;
      return send(res, status, { success: false, error: msg });
    } finally {
      log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    url: publicBase,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const j of jobs.values()) j.controller.abort();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function newJob(kind: Job['kind'], version: Job['version']): Job {
  return {
    id: randomUUID(), kind, version, status: 'scraping', total: 0, completed: 0, data: [],
    createdAt: Date.now(), controller: new AbortController(),
  };
}

/** Firecrawl formats arrive as strings (v1) or objects like {type:'markdown'} (v2). */
function formatsOf(body: Json): Format[] {
  const f = body.formats;
  if (!Array.isArray(f) || f.length === 0) return ['markdown'];
  return f
    .map((x) => (typeof x === 'string' ? x : (x as Json).type === 'screenshot' && (x as Json).fullPage ? 'screenshot@fullPage' : String((x as Json).type ?? '')))
    .filter(Boolean);
}

function scrapeOptions(body: Json): FetchOptions {
  const include = Array.isArray(body.includeTags) ? (body.includeTags as string[]).join(', ') : undefined;
  const maxAgeMs = num(body.maxAge);
  return {
    // On Reddit, HN and friends the discussion *is* the page, as Firecrawl would return it.
    comments: body.scourComments === false ? false : true,
    timeoutMs: num(body.timeout),
    ttl: maxAgeMs !== undefined ? Math.floor(maxAgeMs / 1000) : undefined,
    headers: (body.headers as Record<string, string>) ?? undefined,
    adapterOptions: {
      selector: include,
      full: body.onlyMainContent === false,
      ...(Array.isArray(body.actions) && body.actions.length ? { actions: actionsFromFirecrawl(body.actions) } : {}),
    },
  };
}

/** Map a scour Document onto Firecrawl's scrape response shape. */
async function toFirecrawl(scour: Scour, doc: Document, formats: Format[], body: Json): Promise<Json> {
  const out: Json = {};
  const warnings: string[] = [];
  for (const f of formats) {
    if (f === 'markdown') out.markdown = doc.text;
    else if (f === 'links') out.links = (doc.links ?? []).map((l) => l.url);
    else if (f === 'html' || f === 'rawHtml') {
      try {
        const res = await (scour as unknown as { http: { get(u: string): Promise<{ body: string }> } }).http.get(doc.provenance.finalUrl || doc.url);
        out[f] = res.body;
      } catch (err) {
        warnings.push(`${f}: ${(err as Error).message}`);
      }
    } else if (f === 'screenshot' || f === 'screenshot@fullPage') {
      try {
        const shot = await scour.screenshot(doc.provenance.finalUrl || doc.url, { fullPage: f.endsWith('fullPage') || (body.fullPage as boolean | undefined) === true, format: 'png' });
        out.screenshot = `data:${shot.mimeType};base64,${shot.data.toString('base64')}`;
      } catch (err) {
        warnings.push(`screenshot: ${(err as Error).message}`);
      }
    } else if (f === 'summary') out.summary = doc.excerpt ?? doc.text.slice(0, 500);
    else warnings.push(`format "${f}" is not supported by scour yet; returned markdown instead`);
  }
  if (!out.markdown && !formats.includes('markdown') && warnings.length) out.markdown = doc.text;
  out.metadata = {
    title: doc.title,
    description: doc.excerpt,
    language: doc.lang,
    sourceURL: doc.url,
    url: doc.provenance.finalUrl || doc.url,
    statusCode: doc.provenance.httpStatus ?? 200,
    publishedTime: doc.publishedAt,
    author: doc.author?.name ?? doc.author?.handle,
    // scour extras, harmless to Firecrawl clients
    scourSource: doc.source,
    scourTier: doc.provenance.tierName,
    scourCostUsd: doc.provenance.costUsd,
    cacheState: doc.provenance.cached ? 'hit' : 'miss',
  };
  // Page actions: screenshots and script results, as Firecrawl returns them.
  const acts = doc.extra?.actions as { screenshots: string[]; javascriptReturns: unknown[] } | undefined;
  if (acts) out.actions = { screenshots: acts.screenshots, scrapes: [], javascriptReturns: acts.javascriptReturns, pdfs: [] };
  if (warnings.length) out.warning = warnings.join('; ');
  void body;
  return out;
}

function slim(d: Document): Json {
  const { children, ...rest } = d;
  void children;
  return rest as unknown as Json;
}

function regexList(v: unknown): RegExp | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  try {
    return new RegExp((v as string[]).map((p) => `(?:${p})`).join('|'));
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function srcOf(v: unknown): string {
  return String(v || 'x').toLowerCase().replace(/\bx\b/g, 'twitter');
}

/** Host header names a loopback server legitimately answers to. */
function isLoopbackHost(hostHeader: string): boolean {
  const h = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

const UI_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const NODE_MODULES = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: nodePath.join(UI_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: nodePath.join(UI_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: nodePath.join(UI_DIR, 'style.css'), type: 'text/css; charset=utf-8' },
  '/vendor/marked.js': { file: nodePath.join(NODE_MODULES, 'marked', 'lib', 'marked.umd.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/purify.js': { file: nodePath.join(NODE_MODULES, 'dompurify', 'dist', 'purify.min.js'), type: 'text/javascript; charset=utf-8' },
};

/** Serve the web app's files with a strict Content-Security-Policy. */
async function serveUi(pathname: string, res: ServerResponse): Promise<boolean> {
  const entry = STATIC[pathname];
  if (!entry) return false;
  const bodyBuf = await fsp.readFile(entry.file).catch(() => null);
  if (!bodyBuf) return false;
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Scraped content is untrusted: no inline or remote scripts, ever.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src * data: blob:; media-src *; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(bodyBuf);
  return true;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function authorized(req: IncomingMessage, key?: string): boolean {
  if (!key) return true;
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(key);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request body must be under 1 MB');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Json;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = status === 204 ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
