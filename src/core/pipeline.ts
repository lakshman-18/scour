import { FetchHttpClient } from './http.js';
import { FileCache, NullCache, hashKey } from './cache.js';
import { Ledger } from './budget.js';
import { Registry } from './registry.js';
import { ConsoleLogger, nullLogger } from './logger.js';
import { renderPage } from '../render/browser.js';
import {
  BudgetExceeded,
  NeedsConfig,
  Tier,
  TIER_NAMES,
  TierError,
  type Adapter,
  type AdapterContext,
  type BudgetLedger,
  type CacheStore,
  type HttpClient,
  type HttpInit,
  type Document,
  type FetchOptions,
  type HealthReport,
  type Logger,
  type Provenance,
  type RenderOptions,
  type RenderedPage,
  type ScourConfig,
  type SearchResponse,
  type SearchResult,
} from './types.js';
import { cleanTitle, describeHidden, matchQuery, norm, parseQuery, type MissReason } from './query.js';

export interface ScourDeps {
  config: ScourConfig;
  registry: Registry;
  logger?: Logger;
  cache?: CacheStore;
}

/**
 * The engine. One public surface: `get`, `search`, `health`.
 *
 * Every fetch walks the tier ladder from cheapest to dearest and stops at the
 * first tier that returns a usable document. The budget ledger makes it
 * impossible to silently cross into paid territory.
 */
export class Scour {
  readonly config: ScourConfig;
  readonly registry: Registry;
  readonly log: Logger;
  readonly cache: CacheStore;
  readonly budget: Ledger;
  private http: FetchHttpClient;
  /** Guards against cyclic subFetch (A embeds B embeds A). */
  private inFlight = new Set<string>();

  constructor(deps: ScourDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.log = deps.logger ?? nullLogger;
    this.cache = deps.cache ?? new FileCache(deps.config.cacheDir);
    this.budget = new Ledger(deps.config.maxCostUsd);
    this.http = new FetchHttpClient({
      userAgent: deps.config.userAgent,
      defaultTimeoutMs: deps.config.timeoutMs,
      politenessMs: deps.config.politenessMs,
      proxy: deps.config.proxy,
      log: this.log,
    });
  }

  /** Fetch one URL and return the unified Document. */
  async get(input: string, options: FetchOptions = {}): Promise<Document> {
    const url = normaliseUrl(input);
    const adapter = this.registry.resolve(url);
    return this.runAdapter(adapter, url, options);
  }

  private async runAdapter(adapter: Adapter, url: URL, options: FetchOptions): Promise<Document> {
    const started = Date.now();
    const opts = this.mergeOptions(options);
    const maxTier = opts.maxTier ?? this.config.maxTier;
    const cacheKey = await this.cacheKeyFor(adapter.name, url, opts);

    // ---- Tier 0: cache -------------------------------------------------
    if (!opts.noCache) {
      const hit = await this.cache.get<Document>(cacheKey, opts.ttl);
      if (hit) {
        this.log.debug(`cache hit ${url.href}`);
        return {
          ...hit.value,
          provenance: {
            ...hit.value.provenance,
            tier: Tier.Cache,
            tierName: 'cache',
            cached: true,
            elapsedMs: Date.now() - started,
            costUsd: 0,
            bytes: 0,
            fetchedAt: hit.value.provenance.fetchedAt,
          },
        };
      }
    }

    const attempts: NonNullable<Provenance['attempts']> = [];
    const meter = { bytes: 0, costUsd: 0 };
    const ctx = this.makeContext(opts, attempts, meter);

    // ---- Tiers 1..4: the adapter decides how far it climbs --------------
    let doc: Document;
    try {
      doc = await adapter.fetch(url, ctx);
    } catch (err) {
      // An adapter that cannot reach its target at the allowed tier falls back
      // to the generic one, which may still get a usable page.
      const generic = this.registry.byName('web');
      const canFallBack =
        generic && adapter.name !== 'web' && !(err instanceof BudgetExceeded) && !(err instanceof NeedsConfig);
      if (canFallBack) {
        attempts.push({
          tier: (err as TierError).tier ?? Tier.Native,
          strategy: adapter.name,
          error: (err as Error).message,
          ms: Date.now() - started,
        });
        this.log.warn(`${adapter.name} adapter failed (${(err as Error).message}); falling back to generic web`);
        doc = await generic!.fetch(url, ctx);
      } else {
        throw this.decorate(err, url, maxTier);
      }
    }

    doc.provenance = {
      ...doc.provenance,
      elapsedMs: Date.now() - started,
      cached: false,
      bytes: Math.max(meter.bytes, doc.provenance.bytes ?? 0),
      costUsd: meter.costUsd,
      attempts: attempts.length ? attempts : undefined,
      fetchedAt: doc.provenance.fetchedAt || new Date().toISOString(),
    };

    const ttl = opts.ttl ?? this.config.defaultTtlSec;
    if (ttl > 0 && !doc.extra?.degraded) await this.cache.set(cacheKey, doc, ttl);
    return doc;
  }

  /**
   * Search. With no `source`, fan out across every searchable adapter plus the
   * web search providers, then merge.
   */
  async search(
    query: string,
    opts: FetchOptions & { source?: string; limit?: number; sort?: 'relevance' | 'engagement' | 'recent' } = {},
  ): Promise<SearchResponse> {
    const started = Date.now();
    // One source, several ("reddit,hn,x"), or all. Tolerate case, stray
    // punctuation ("twitter.") and the "x" alias.
    const names = (opts.source ?? '')
      .split(/[,\s]+/)
      .map((n) => n.toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean)
      .map((n) => (n === 'x' ? 'twitter' : n === 'web' ? 'websearch' : n));
    const single = names.length === 1;
    opts = { ...opts, source: names.length ? names.join(',') : undefined };
    const merged = this.mergeOptions(opts);
    const limit = opts.limit ?? 10;
    const ctx = this.makeContext(merged, []);
    const fresh = (opts.adapterOptions as { freshness?: string } | undefined)?.freshness ?? '';
    const cacheKey = `search:${opts.source ?? 'all'}:${hashKey(query)}:${limit}:${fresh}`;

    if (!merged.noCache) {
      const hit = await this.cache.get<SearchResponse>(cacheKey, merged.ttl);
      if (hit) {
        return {
          ...hit.value,
          provenance: { ...hit.value.provenance, cached: true, tier: Tier.Cache, tierName: 'cache', elapsedMs: Date.now() - started },
        };
      }
    }

    const targets = names.length
      ? names.map((n) => {
          const a = this.registry.byName(n);
          if (!a) throw new Error(`Unknown source "${n}". Try: ${this.registry.searchable.map((x) => x.name).join(', ')}`);
          if (!a.search) throw new Error(`Source "${n}" does not support search.`);
          return a;
        })
      : this.registry.searchable;

    // Operators (-word, from:, names) are applied here, after the engines
    // answer, so they mean the same thing on every platform. Adapters that
    // understand them natively (the X API) get the raw query.
    const pq = parseQuery(query);
    const queryFor = (a: Adapter) => (a.queryOperators ? query : pq.text);
    const adapterNotes: string[] = [];
    ctx.note = (m) => { if (!adapterNotes.includes(m)) adapterNotes.push(m); };

    // With several sources each gets a deadline; a single slow or
    // rate-limited platform must not stall the whole answer.
    const deadlineMs = single ? undefined : Math.min(merged.timeoutMs, 8000);
    const settled = await Promise.allSettled(
      targets.map((a) => {
        const q = queryFor(a);
        if (!q.trim()) return Promise.resolve([] as SearchResult[]); // e.g. only from:handle, on a platform without accounts
        if (!deadlineMs) return a.search!(q, ctx, limit);
        const ac = new AbortController();
        const sourceCtx = { ...this.makeContext({ ...merged, signal: ac.signal }, []), note: ctx.note };
        return withDeadline(a.search!(q, sourceCtx, limit), deadlineMs, a.name, ac);
      }),
    );
    const perSource: SearchResult[][] = [];
    const used: string[] = [];
    const hidden: Partial<Record<MissReason, number>> = {};
    let answered = 0;
    for (const [i, s] of settled.entries()) {
      const a = targets[i]!;
      if (s.status === 'rejected') {
        this.log.debug(`search via ${a.name} failed: ${s.reason?.message ?? s.reason}`);
        continue;
      }
      if (!s.value.length) continue;
      answered++;
      // Filter before trimming to the limit, so real matches further down the
      // engine's list replace the ones that were hidden.
      let list = s.value.filter((r) => {
        const m = matchQuery(r, pq, { complete: !!a.completeSnippets });
        if (!m.ok) hidden[m.reason] = (hidden[m.reason] ?? 0) + 1;
        return m.ok;
      });
      // In fan-out mode, also drop off-topic hits: keyword engines on Stack
      // Overflow, Wikipedia and GitHub happily return "dots" for "OpenAI Dots".
      if (!single) list = list.filter((r) => isRelevant(r, pq.text));
      if (list.length) {
        perSource.push(list.slice(0, limit));
        used.push(a.name);
      }
    }
    // Round-robin so the top hit from every source surfaces before any
    // source's second hit — one noisy platform can't crowd out the rest.
    let results: SearchResult[] = [];
    for (let rank = 0; rank < limit; rank++) {
      for (const list of perSource) if (list[rank]) results.push(list[rank]!);
    }
    if (opts.sort === 'engagement') results = [...results].sort((a, b) => engagementScore(b) - engagementScore(a));
    else if (opts.sort === 'recent') results = [...results].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

    const notes = [...adapterNotes, ...describeHidden(pq, hidden)];
    if (results.length === 0 && answered === 0 && adapterNotes.length === 0 && settled.length > 0) {
      const reasons = settled
        .map((s, i) => (s.status === 'rejected' ? `${targets[i]!.name}: ${s.reason?.message ?? s.reason}` : null))
        .filter(Boolean);
      throw new Error(`No search backend returned results.\n${reasons.join('\n')}`);
    }
    if (results.length === 0) {
      if (answered) notes.push('Nothing matched exactly: every result the search engines returned failed the checks above.');
      for (const a of targets) {
        const hint = a.emptyHint?.(pq);
        if (hint) notes.push(hint);
      }
    }

    const response: SearchResponse = {
      query,
      results: dedupeResults(results),
      ...(notes.length ? { notes } : {}),
      provenance: {
        tier: Tier.Native,
        tierName: 'native',
        adapter: single ? opts.source! : 'multi',
        strategy: (used.length ? used : targets.map((t) => t.name)).join('+'),
        finalUrl: '',
        elapsedMs: Date.now() - started,
        costUsd: this.budget.spentUsd,
        bytes: this.http.bytes,
        cached: false,
        fetchedAt: new Date().toISOString(),
      },
    };

    // A degraded answer (a route skipped or rate-limited) is not cached, so
    // the next search tries again.
    const ttl = merged.ttl ?? Math.min(this.config.defaultTtlSec, 900);
    if (ttl > 0 && !adapterNotes.length) await this.cache.set(cacheKey, response, ttl);
    return response;
  }

  /** Image of a page as a browser shows it. Needs the headless tier (Playwright). */
  async screenshot(input: string, opts: import('../render/browser.js').ScreenshotOptions & { maxTier?: Tier } = {}) {
    const maxTier = opts.maxTier ?? this.config.maxTier;
    if (maxTier < Tier.Headless) {
      throw new Error(`Screenshots need the headless tier but --max-tier is ${TIER_NAMES[maxTier]}.`);
    }
    const { screenshotPage } = await import('../render/browser.js');
    return screenshotPage(normaliseUrl(input).href, {
      userAgent: this.config.userAgent, proxy: this.config.proxy, log: this.log, timeoutMs: this.config.timeoutMs,
    }, opts);
  }

  /** Per-adapter configuration status, for `scour doctor`. */
  async health(): Promise<HealthReport[]> {
    const ctx = this.makeContext(this.mergeOptions({}), []);
    const out: HealthReport[] = [];
    for (const a of this.registry.all) {
      if (!a.health) {
        out.push({
          adapter: a.name, status: 'ready', detail: 'No configuration required.',
          capabilities: ['read', ...(a.search ? ['search'] : [])],
        });
        continue;
      }
      try {
        out.push(await a.health(ctx));
      } catch (err) {
        out.push({ adapter: a.name, status: 'down', detail: (err as Error).message, capabilities: [] });
      }
    }
    return out;
  }

  private mergeOptions(o: FetchOptions): FetchOptions & { timeoutMs: number } {
    return {
      ...o,
      timeoutMs: o.timeoutMs ?? this.config.timeoutMs,
      maxTier: o.maxTier ?? this.config.maxTier,
      ttl: o.ttl ?? this.config.defaultTtlSec,
      proxy: o.proxy ?? this.config.proxy,
    };
  }

  private makeContext(
    opts: FetchOptions & { timeoutMs: number },
    attempts: NonNullable<Provenance['attempts']>,
    meter: { bytes: number; costUsd: number } = { bytes: 0, costUsd: 0 },
  ): AdapterContext {
    const maxTier = opts.maxTier ?? this.config.maxTier;
    const http = this.http;
    // Per-call views over the shared client and ledger, so each document
    // reports its own bytes and spend even when many run concurrently.
    // The context's signal rides along on every request, so cancelling a
    // context really stops its network work instead of just ignoring it.
    const sig = (i?: HttpInit): HttpInit | undefined => (opts.signal && !i?.signal ? { ...i, signal: opts.signal } : i);
    const scopedHttp: HttpClient = {
      get: async (u, i) => { const r = await http.get(u, sig(i)); meter.bytes += r.bytes; return r; },
      post: async (u, b, i) => { const r = await http.post(u, b, sig(i)); meter.bytes += r.bytes; return r; },
      json: async <T>(u: string, i?: HttpInit) => {
        const r = await http.get(u, { ...sig(i), headers: { Accept: 'application/json', ...i?.headers } });
        meter.bytes += r.bytes;
        try { return JSON.parse(r.body) as T; } catch { return http.json<T>(u, i); }
      },
      get bytes() { return meter.bytes; },
    };
    const ledger = this.budget;
    const scopedBudget: BudgetLedger = {
      charge: (amount, label) => { ledger.charge(amount, label); meter.costUsd += Math.max(0, amount); },
      canAfford: (amount) => ledger.canAfford(amount),
      get spentUsd() { return ledger.spentUsd; },
      get capUsd() { return ledger.capUsd; },
      get entries() { return ledger.entries; },
    };
    return {
      options: opts,
      http: scopedHttp,
      cache: this.cache,
      budget: scopedBudget,
      config: this.config,
      log: this.log,
      render: async (url: string, ro?: RenderOptions): Promise<RenderedPage> => {
        if (maxTier < Tier.Headless) {
          throw new TierError(
            `Rendering ${url} needs the headless tier but --max-tier is ${TIER_NAMES[maxTier]}. ` +
              `Re-run with --max-tier headless.`,
            Tier.Headless,
            false,
          );
        }
        const t0 = Date.now();
        try {
          return await renderPage(url, {
            userAgent: this.config.userAgent,
            proxy: opts.proxy,
            log: this.log,
            timeoutMs: opts.timeoutMs,
          }, ro);
        } catch (err) {
          attempts.push({ tier: Tier.Headless, strategy: 'playwright', error: (err as Error).message, ms: Date.now() - t0 });
          throw err;
        }
      },
      subFetch: async (url: string, sub?: FetchOptions): Promise<Document> => {
        const key = normaliseUrl(url).href;
        if (this.inFlight.has(key)) throw new Error(`Cyclic fetch detected for ${key}`);
        this.inFlight.add(key);
        try {
          return await this.get(url, { ...opts, ...sub });
        } finally {
          this.inFlight.delete(key);
        }
      },
    };
  }

  private async cacheKeyFor(adapter: string, url: URL, opts: FetchOptions): Promise<string> {
    // Options that change the *content* must be part of the key; options that
    // only change cost/transport (proxy, timeout) must not. A saved login
    // changes what a site shows, so a page read before you logged in is not
    // served from cache afterwards.
    const ao = opts.adapterOptions as Record<string, unknown> | undefined;
    const { sessionForHost } = await import('../render/sessions.js');
    const session = await sessionForHost(url.hostname).catch(() => null);
    const salient = {
      comments: opts.comments ?? false,
      transcript: opts.transcript ?? true,
      selector: ao?.selector ?? null,
      full: ao?.full ?? false,
      ...(ao?.actions ? { actions: ao.actions } : {}),
      ...(ao?.lang ? { lang: ao.lang } : {}),
      ...(ao?.frames ? { frames: ao.frames } : {}),
      ...(ao?.transcribe ? { transcribe: true } : {}),
      ...(ao?.keepSponsors ? { keepSponsors: true } : {}),
      ...(session ? { login: session.meta.savedAt } : {}),
    };
    return `doc:${adapter}:${canonicalUrl(url)}:${hashKey(JSON.stringify(salient)).slice(0, 12)}`;
  }

  private decorate(err: unknown, url: URL, maxTier: Tier): Error {
    if (err instanceof TierError && err.tier > maxTier) {
      return new Error(
        `${url.href} needs the "${TIER_NAMES[err.tier]}" tier but the ceiling is "${TIER_NAMES[maxTier]}".\n` +
          `  ${err.message}\n  Raise it with --max-tier ${TIER_NAMES[err.tier]}.`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async close(): Promise<void> {
    const { closeBrowser } = await import('../render/browser.js');
    await closeBrowser();
  }
}

/** Tracking params make otherwise-identical URLs miss the cache. Strip them. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_src|ref_url|igshid|si|_ga|yclid|msclkid|spm)/i;

export function canonicalUrl(url: URL): string {
  const u = new URL(url.href);
  u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  u.search = '';
  for (const [k, v] of keep.sort(([a], [b]) => a.localeCompare(b))) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

export function normaliseUrl(input: string): URL {
  const trimmed = input.trim();
  try {
    return new URL(trimmed);
  } catch {
    // Bare hosts and `example.com/path` are what people actually paste.
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      throw new Error(`Not a usable URL: "${input}"`);
    }
  }
}

/**
 * Is this hit *about* the query, not just mentioning its words? All meaningful
 * terms must appear close together (within a few words) in the title or the
 * snippet, names keep their spelling ("ToolMark" is not "toolmark"), and the
 * query's operators (-word, "phrase", from:) apply. "OpenAI launches dots"
 * passes for "OpenAI Dots"; "weird dots … inside OpenAI's Dall-E" does not.
 */
export function isAbout(r: SearchResult, query: string): boolean {
  return matchQuery(r, parseQuery(query), { complete: true }).ok;
}

/**
 * How well a hit matches the query, for ranking (not filtering). The exact
 * phrase ("OpenAI's Dots" counts) beats scattered words: "connect the dots"
 * plus "OpenAI" somewhere is not about OpenAI Dots. Recent items get a nudge.
 */
export function relevanceScore(r: SearchResult, query: string, now = Date.now()): number {
  const pq = parseQuery(query);
  const terms = pq.terms;
  if (!terms.length) return 0;
  const q = terms.join(' ');
  const title = norm(cleanTitle(r.title ?? ''));
  const all = norm([r.title, r.snippet, r.author?.name, r.author?.handle, r.url].filter(Boolean).join(' '));
  let score = isAbout(r, query) ? 2 : 0;
  if (terms.length > 1 && title.includes(q)) score += 4;
  else if (terms.length > 1 && all.includes(q)) score += 2.5;
  score += (2 * terms.filter((t) => title.includes(t)).length) / terms.length;
  score += terms.filter((t) => all.includes(t)).length / terms.length;
  if (r.publishedAt) {
    const ageDays = (now - Date.parse(r.publishedAt)) / 86_400_000;
    if (ageDays >= 0 && ageDays < 30) score += 1;
    else if (ageDays > 365) score -= 0.5;
  }
  return score;
}

/** One comparable number across platforms: likes/points, plus discussion weighted higher. */
export function engagementScore(r: SearchResult): number {
  const e = r.engagement ?? {};
  return (e.score ?? 0) + 3 * (e.comments ?? 0) + 2 * (e.shares ?? 0) + (e.views ?? 0) / 100;
}

/**
 * Lexical relevance: a hit must mention most of the query's meaningful terms
 * somewhere in its title, snippet, author or URL. Cheap, deterministic, and it
 * removes the single-keyword matches that make fan-out results noisy.
 */
export function isRelevant(r: SearchResult, query: string): boolean {
  const terms = parseQuery(query).terms;
  if (terms.length <= 1) return true;
  const hay = [r.title, r.snippet, r.author?.name, r.author?.handle, r.url, r.extra?.subreddit]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const hit = terms.filter((t) => hay.includes(t)).length;
  return hit / terms.length >= 0.6;
}

function withDeadline<T>(p: Promise<T>, ms: number, label: string, ac?: AbortController): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} exceeded the ${ms}ms fan-out deadline`);
        ac?.abort(err); // cancel its in-flight requests, don't just stop waiting
        reject(err);
      }, ms);
    }),
  ]);
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    let k: string;
    try {
      k = canonicalUrl(new URL(r.url));
    } catch {
      k = r.url;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export { ConsoleLogger, FileCache, NullCache, Registry };
