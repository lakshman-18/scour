import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tier, type Credentials, type ScourConfig } from './types.js';
import { randomUserAgent } from './http.js';

export function configHome(): string {
  return process.env.SCOUR_HOME ?? path.join(os.homedir(), '.scour');
}

export function defaultConfig(): ScourConfig {
  const home = configHome();
  return {
    cacheDir: process.env.SCOUR_CACHE_DIR ?? path.join(home, 'cache'),
    defaultTtlSec: num(process.env.SCOUR_TTL, 3600),
    maxTier: parseTier(process.env.SCOUR_MAX_TIER) ?? Tier.Headless,
    maxCostUsd: num(process.env.SCOUR_MAX_COST, 0),
    timeoutMs: num(process.env.SCOUR_TIMEOUT_MS, 30_000),
    concurrency: num(process.env.SCOUR_CONCURRENCY, 5),
    userAgent: process.env.SCOUR_USER_AGENT ?? randomUserAgent(),
    proxy: process.env.SCOUR_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy,
    politenessMs: num(process.env.SCOUR_POLITENESS_MS, 250),
    credentials: credentialsFromEnv(),
    providers: {
      firecrawlKey: process.env.FIRECRAWL_API_KEY,
      jinaKey: process.env.JINA_API_KEY,
      braveKey: process.env.BRAVE_API_KEY,
      tavilyKey: process.env.TAVILY_API_KEY,
      exaKey: process.env.EXA_API_KEY,
      searxngUrl: process.env.SEARXNG_URL,
      xBearerToken: process.env.X_BEARER_TOKEN,
    },
  };
}

function credentialsFromEnv(): Credentials {
  const c: Credentials = {};
  const gh = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (gh) c.githubToken = gh;
  if (process.env.TWITTER_AUTH_TOKEN && process.env.TWITTER_CT0) {
    c.twitter = { authToken: process.env.TWITTER_AUTH_TOKEN, ct0: process.env.TWITTER_CT0 };
  }
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    c.reddit = { clientId: process.env.REDDIT_CLIENT_ID, clientSecret: process.env.REDDIT_CLIENT_SECRET };
  }
  return c;
}

/**
 * Credentials live in ~/.scour/credentials.json at mode 0600 and never leave
 * the machine. Config file layers under env vars, which layer under CLI flags.
 */
export async function loadConfig(overrides: Partial<ScourConfig> = {}): Promise<ScourConfig> {
  const base = defaultConfig();
  const fileCfg = await readJson<Partial<ScourConfig>>(path.join(configHome(), 'config.json'));
  const creds = await readJson<Credentials>(path.join(configHome(), 'credentials.json'));
  return {
    ...base,
    ...stripUndefined(fileCfg ?? {}),
    ...stripUndefined(overrides),
    credentials: { ...(creds ?? {}), ...base.credentials, ...(overrides.credentials ?? {}) },
    providers: { ...(fileCfg?.providers ?? {}), ...stripUndefined(base.providers), ...stripUndefined(overrides.providers ?? {}) },
  };
}

export async function saveCredentials(patch: Credentials): Promise<string> {
  const home = configHome();
  const file = path.join(home, 'credentials.json');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const current = (await readJson<Credentials>(file)) ?? {};
  const merged: Credentials = {
    ...current,
    ...patch,
    cookies: { ...(current.cookies ?? {}), ...(patch.cookies ?? {}) },
  };
  await fs.writeFile(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

export function parseTier(v: string | number | undefined): Tier | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v as Tier;
  const map: Record<string, Tier> = {
    cache: Tier.Cache, '0': Tier.Cache,
    native: Tier.Native, '1': Tier.Native,
    static: Tier.Static, '2': Tier.Static,
    headless: Tier.Headless, browser: Tier.Headless, '3': Tier.Headless,
    paid: Tier.Paid, '4': Tier.Paid,
    free: Tier.Headless,
  };
  const t = map[String(v).toLowerCase()];
  if (t === undefined) throw new Error(`Unknown tier "${v}". Use: cache | native | static | headless | paid`);
  return t;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Save provider keys (Brave, SearXNG URL, …) into ~/.scour/config.json at mode 0600. */
export async function saveProviders(patch: Partial<ScourConfig['providers']>): Promise<string> {
  const home = configHome();
  const file = path.join(home, 'config.json');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const current = (await readJson<Partial<ScourConfig>>(file)) ?? {};
  const merged = { ...current, providers: { ...(current.providers ?? {}), ...patch } };
  await fs.writeFile(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}
