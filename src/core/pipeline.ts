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
    const cacheKey = this.cacheKeyFor(adapter.name, url, opts);

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
    if (ttl > 0) await this.cache.set(cacheKey, doc, ttl);
    return doc;
  }

  /**
   * Search. With no `source`, fan out across every searchable adapter plus the
   * web search providers, then merge.
   */
  async search(
    query: string,
    opts: FetchOptions & { source?: string; limit?: number } = {},
  ): Promise<SearchResponse> {
    const started = Date.now();
    const merged = this.mergeOptions(opts);
    const limit = opts.limit ?? 10;
    const ctx = this.makeContext(merged, []);
    const cacheKey = `search:${opts.source ?? 'all'}:${hashKey(query)}:${limit}`;

    if (!merged.noCache) {
      const hit = await this.cache.get<SearchResponse>(cacheKey, merged.ttl);
      if (hit) {
        return {
          ...hit.value,
          provenance: { ...hit.value.provenance, cached: true, tier: Tier.Cache, tierName: 'cache', elapsedMs: Date.now() - started },
        };
      }
    }

    // Tolerate stray punctuation and case: "twitter." / "Reddit" / "x".
    if (opts.source) {
      const cleaned = opts.source.toLowerCase().replace(/[^a-z0-9-]/g, '');
      opts = { ...opts, source: cleaned === 'x' ? 'twitter' : cleaned };
    }
    const targets = opts.source
      ? [this.registry.byName(opts.source)].filter((a): a is Adapter => {
          if (!a) throw new Error(`Unknown source "${opts.source}". Try: ${this.registry.searchable.map((s) => s.name).join(', ')}`);
          if (!a.search) throw new Error(`Source "${opts.source}" does not support search.`);
          return true;
        })
      : this.registry.searchable;

    // In fan-out mode each source gets a deadline; a single slow or
    // rate-limited platform must not stall the whole answer.
    const deadlineMs = opts.source ? undefined : Math.min(merged.timeoutMs, 8000);
    const settled = await Promise.allSettled(
      targets.map((a) => {
        if (!deadlineMs) return a.search!(query, ctx, limit);
        const ac = new AbortController();
        const sourceCtx = this.makeContext({ ...merged, signal: ac.signal }, []);
        return withDeadline(a.search!(query, sourceCtx, limit), deadlineMs, a.name, ac);
      }),
    );
    const perSource: SearchResult[][] = [];
    const used: string[] = [];
    for (const [i, s] of settled.entries()) {
      if (s.status === 'fulfilled' && s.value.length) {
        perSource.push(s.value.slice(0, limit));
        used.push(targets[i]!.name);
      } else if (s.status === 'rejected') {
        this.log.debug(`search via ${targets[i]!.name} failed: ${s.reason?.message ?? s.reason}`);
      }
    }
    // In fan-out mode, drop off-topic hits: keyword engines on Stack Overflow,
    // Wikipedia and GitHub happily return "dots" results for "OpenAI Dots".
    const filtered = opts.source ? perSource : perSource.map((list) => list.filter((r) => isRelevant(r, query)));
    // Round-robin so the top hit from every source surfaces before any
    // source's second hit — one noisy platform can't crowd out the rest.
    const results: SearchResult[] = [];
    for (let rank = 0; rank < limit; rank++) {
      for (const list of filtered) if (list[rank]) results.push(list[rank]!);
    }

    if (results.length === 0 && settled.length > 0) {
      const reasons = settled
        .map((s, i) => (s.status === 'rejected' ? `${targets[i]!.name}: ${s.reason?.message ?? s.reason}` : null))
        .filter(Boolean);
      throw new Error(`No search backend returned results.\n${reasons.join('\n')}`);
    }

    const response: SearchResponse = {
      query,
      results: dedupeResults(results),
      provenance: {
        tier: Tier.Native,
        tierName: 'native',
        adapter: opts.source ?? 'multi',
        strategy: (used.length ? used : targets.map((t) => t.name)).join('+'),
        finalUrl: '',
        elapsedMs: Date.now() - started,
        costUsd: this.budget.spentUsd,
        bytes: this.http.bytes,
        cached: false,
        fetchedAt: new Date().toISOString(),
      },
    };

    const ttl = merged.ttl ?? Math.min(this.config.defaultTtlSec, 900);
    if (ttl > 0) await this.cache.set(cacheKey, response, ttl);
    return response;
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

  private cacheKeyFor(adapter: string, url: URL, opts: FetchOptions): string {
    // Options that change the *content* must be part of the key; options that
    // only change cost/transport (proxy, timeout) must not.
    const salient = {
      comments: opts.comments ?? false,
      transcript: opts.transcript ?? true,
      selector: (opts.adapterOptions as Record<string, unknown> | undefined)?.selector ?? null,
      full: (opts.adapterOptions as Record<string, unknown> | undefined)?.full ?? false,
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

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'why', 'are', 'you', 'your', 'from', 'that', 'this', 'into', 'about', 'vs', 'site']);

/**
 * Lexical relevance: a hit must mention most of the query's meaningful terms
 * somewhere in its title, snippet, author or URL. Cheap, deterministic, and it
 * removes the single-keyword matches that make fan-out results noisy.
 */
export function isRelevant(r: SearchResult, query: string): boolean {
  const terms = query
    .toLowerCase()
    .replace(/site:\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
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
