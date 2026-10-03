/**
 * The unified schema. Every adapter, every tier, every site collapses to this.
 * A tweet, a Reddit thread, a YouTube transcript and a random blog post all
 * come back as `Document`. That is the entire point of scour.
 */

/** Cost tiers, cheapest first. The pipeline climbs only as far as it must. */
export enum Tier {
  /** Served from local cache. Free, instant. */
  Cache = 0,
  /** Platform-native free endpoint (syndication JSON, oEmbed, public REST). */
  Native = 1,
  /** Plain HTTP GET + HTML extraction. Free, costs only bandwidth. */
  Static = 2,
  /** Headless browser render. Free in money, expensive in CPU/seconds. */
  Headless = 3,
  /** Third-party paid API (Firecrawl, Apify, Jina paid, Brave). Costs money. */
  Paid = 4,
}

export const TIER_NAMES: Record<Tier, string> = {
  [Tier.Cache]: 'cache',
  [Tier.Native]: 'native',
  [Tier.Static]: 'static',
  [Tier.Headless]: 'headless',
  [Tier.Paid]: 'paid',
};

export type DocumentKind =
  | 'article'      // blog post, news, docs page
  | 'post'         // social post (tweet, reddit submission, HN story)
  | 'comment'      // reply in a thread
  | 'video'        // video + transcript
  | 'repository'   // code repo
  | 'issue'        // issue / PR / discussion
  | 'profile'      // user or org page
  | 'listing'      // search results page, feed, index
  | 'file'         // raw file (source, json, csv)
  | 'unknown';

/** A person or org attached to a document. */
export interface Author {
  /** Handle without the @ (e.g. "simonw"). */
  handle?: string;
  /** Display name. */
  name?: string;
  url?: string;
  avatar?: string;
  /** Follower count etc., when the platform gives it cheaply. */
  followers?: number;
  verified?: boolean;
}

/** Platform engagement numbers, normalised across sources. */
export interface Engagement {
  /** Upvotes, likes, hearts, stars — whatever the platform's primary signal is. */
  score?: number;
  comments?: number;
  shares?: number;   // retweets, reposts, forks
  views?: number;
  /** 0..1 where the platform exposes it (Reddit upvote ratio). */
  ratio?: number;
}

export interface MediaItem {
  type: 'image' | 'video' | 'audio' | 'gif';
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** For video/audio: the transcript, if we got one cheaply. */
  transcript?: string;
}

export interface LinkRef {
  url: string;
  text?: string;
  /** true when the link points off the document's own host. */
  external?: boolean;
}

/** Provenance: how this document was obtained, and what it cost. */
export interface Provenance {
  tier: Tier;
  tierName: string;
  /** Which adapter produced it ("reddit", "generic", ...). */
  adapter: string;
  /** The specific strategy inside the adapter ("syndication", "old.reddit json"). */
  strategy: string;
  /** Final URL after redirects. */
  finalUrl: string;
  httpStatus?: number;
  /** Wall-clock milliseconds spent. */
  elapsedMs: number;
  /** Estimated USD. 0 for every free tier — that's the product promise. */
  costUsd: number;
  /** Bytes pulled over the wire (0 on a cache hit). */
  bytes: number;
  /** True if this came from cache. */
  cached: boolean;
  /** True if we revalidated with ETag/If-Modified-Since and got a 304. */
  revalidated?: boolean;
  fetchedAt: string;
  /** Tiers we tried and why they failed — the debugging story. */
  attempts?: { tier: Tier; strategy: string; error: string; ms: number }[];
}

/** The one shape to rule them all. */
export interface Document {
  /** Stable id: `${source}:${nativeId}` when we have one, else the URL hash. */
  id: string;
  /** Canonical URL for a human. */
  url: string;
  /** Adapter/platform name: "reddit", "twitter", "youtube", "web", ... */
  source: string;
  kind: DocumentKind;

  title?: string;
  /** Clean Markdown body. The field agents actually read. */
  text: string;
  /** Short summary/excerpt when the source provides one (never LLM-generated here). */
  excerpt?: string;
  lang?: string;

  author?: Author;
  publishedAt?: string;
  updatedAt?: string;

  engagement?: Engagement;
  media?: MediaItem[];
  links?: LinkRef[];
  tags?: string[];

  /** Threaded replies (Reddit comments, tweet thread, HN children). */
  children?: Document[];

  /** Anything platform-specific that doesn't fit above. Never load-bearing. */
  extra?: Record<string, unknown>;

  provenance: Provenance;
}

/** A search hit — deliberately lighter than a full Document. */
export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  source: string;
  publishedAt?: string;
  author?: Author;
  engagement?: Engagement;
  extra?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  provenance: Provenance;
}

/** Options threaded through the whole pipeline. */
export interface FetchOptions {
  /** Cache TTL in seconds. 0 disables read (still writes). Default 3600. */
  ttl?: number;
  /** Skip cache read entirely. */
  noCache?: boolean;
  /** Highest tier the pipeline may climb to. Default Headless (free only). */
  maxTier?: Tier;
  /** Hard ceiling in USD for this single call. Default 0 (free only). */
  maxCostUsd?: number;
  timeoutMs?: number;
  /** Include N levels of comments/replies where the adapter supports it. */
  comments?: number | boolean;
  /** Fetch transcripts for video/audio. Default true when free. */
  transcript?: boolean;
  /** Override User-Agent. */
  userAgent?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Proxy URL (http://user:pass@host:port). */
  proxy?: string;
  /** Respect robots.txt. Default true for crawl, false for single explicit fetch. */
  respectRobots?: boolean;
  /** Per-adapter knobs. */
  adapterOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** What an adapter must implement. ~50 lines gets you a new platform. */
export interface Adapter {
  name: string;
  /** Higher wins when several adapters match. Generic is -100. */
  priority?: number;
  /** Does this adapter handle the URL? */
  match(url: URL): boolean;
  /** Fetch and normalise. Throws TierError to signal "escalate". */
  fetch(url: URL, ctx: AdapterContext): Promise<Document>;
  /** Optional: platform-scoped search. */
  search?(query: string, ctx: AdapterContext, limit?: number): Promise<SearchResult[]>;
  /** Optional: report configuration state for `scour doctor`. */
  health?(ctx: AdapterContext): Promise<HealthReport>;
}

export interface HealthReport {
  adapter: string;
  /** "ready" = works now. "degraded" = works but limited. "needs-config" = user action. */
  status: 'ready' | 'degraded' | 'needs-config' | 'down';
  detail: string;
  /** Exactly what the user should do, if anything. */
  fix?: string;
  /** Capabilities unlocked at the current config level. */
  capabilities: string[];
}

export interface AdapterContext {
  options: Required<Pick<FetchOptions, 'timeoutMs'>> & FetchOptions;
  http: HttpClient;
  cache: CacheStore;
  budget: BudgetLedger;
  config: ScourConfig;
  log: Logger;
  /** Render a URL in a headless browser. Throws if Tier.Headless is not allowed. */
  render(url: string, opts?: RenderOptions): Promise<RenderedPage>;
  /** Recursively fetch another URL through the full pipeline. */
  subFetch(url: string, opts?: FetchOptions): Promise<Document>;
}

export interface RenderOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  waitForSelector?: string;
  timeoutMs?: number;
  /** Scroll to the bottom N times to trigger lazy loading. */
  scroll?: number;
  /** Execute JS in page and return the value. */
  evaluate?: string;
  /** Cookies to inject. */
  cookies?: { name: string; value: string; domain: string; path?: string }[];
  blockResources?: ('image' | 'font' | 'media' | 'stylesheet')[];
  /** Collect the bodies of network responses whose URL matches — what the page itself fetched. */
  captureResponses?: RegExp;
  /** With captureResponses: stop waiting once this many matching responses arrive. Default 1. */
  captureCount?: number;
}

export interface RenderedPage {
  html: string;
  url: string;
  status: number;
  title?: string;
  evaluated?: unknown;
  captured?: { url: string; status: number; body: string }[];
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  /** True when the server answered 304 and we served cached bytes. */
  notModified?: boolean;
}

export interface HttpClient {
  get(url: string, init?: HttpInit): Promise<HttpResponse>;
  post(url: string, body: unknown, init?: HttpInit): Promise<HttpResponse>;
  json<T = unknown>(url: string, init?: HttpInit): Promise<T>;
  /** Total bytes pulled by this client instance. */
  readonly bytes: number;
}

export interface HttpInit {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Number of retries on 5xx/network error. Default 2. */
  retries?: number;
  /** Treat these statuses as success instead of throwing. */
  allowStatus?: number[];
  signal?: AbortSignal;
  proxy?: string;
  /** Send If-None-Match / If-Modified-Since from a previous response. */
  revalidate?: { etag?: string; lastModified?: string };
  redirect?: 'follow' | 'manual';
  contentType?: string;
}

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  storedAt: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
  /** Hash of the value, for change detection in `watch`. */
  hash: string;
}

export interface CacheStore {
  get<T>(key: string, ttlSec?: number): Promise<CacheEntry<T> | null>;
  /** Returns an entry even if expired — for ETag revalidation. */
  getStale<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, value: T, ttlSec: number, meta?: { etag?: string; lastModified?: string }): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<number>;
  stats(): Promise<{ entries: number; bytes: number }>;
}

export interface BudgetLedger {
  /** Throws BudgetExceeded if this spend would breach the cap. */
  charge(amountUsd: number, label: string): void;
  canAfford(amountUsd: number): boolean;
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly entries: { label: string; amountUsd: number; at: number }[];
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface ScourConfig {
  cacheDir: string;
  defaultTtlSec: number;
  maxTier: Tier;
  maxCostUsd: number;
  timeoutMs: number;
  concurrency: number;
  userAgent: string;
  proxy?: string;
  /** Per-host politeness delay in ms. */
  politenessMs: number;
  credentials: Credentials;
  /** Paid provider API keys — only consulted when maxTier >= Paid. */
  providers: {
    firecrawlKey?: string;
    jinaKey?: string;
    braveKey?: string;
    tavilyKey?: string;
    exaKey?: string;
    searxngUrl?: string;
    /** Official X API (pay-per-use) app bearer token. */
    xBearerToken?: string;
  };
}

export interface Credentials {
  githubToken?: string;
  twitter?: { authToken: string; ct0: string };
  reddit?: { clientId: string; clientSecret: string };
  /** Raw cookie strings per host, for anything else. */
  cookies?: Record<string, string>;
}

/** Thrown by an adapter to say "I can't do this at my tier, escalate." */
export class TierError extends Error {
  constructor(message: string, public readonly tier: Tier, public readonly retryable = true) {
    super(message);
    this.name = 'TierError';
  }
}

export class BudgetExceeded extends Error {
  constructor(public readonly requested: number, public readonly cap: number, public readonly spent: number) {
    super(
      `Budget exceeded: this call needs $${requested.toFixed(4)} but only ` +
        `$${(cap - spent).toFixed(4)} of the $${cap.toFixed(2)} cap remains. ` +
        `Raise it with --max-cost, or keep it free with --max-tier headless.`,
    );
    this.name = 'BudgetExceeded';
  }
}

export class NeedsConfig extends Error {
  constructor(public readonly adapter: string, message: string, public readonly fix: string) {
    super(message);
    this.name = 'NeedsConfig';
  }
}
