import * as cheerio from 'cheerio';
import { PRICES } from '../core/budget.js';
import { costOf, recordUsage } from '../core/usage.js';
import { normDate } from '../core/extract.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type SearchResult,
} from '../core/types.js';
import { truncate } from '../adapters/_helpers.js';

/**
 * General web search, free first.
 *
 * Ladder: SearXNG (self-hosted) → Tavily (1,000 free/month, no card) → Brave
 * ($5 monthly credit, card on file) → DuckDuckGo Lite → Marginalia → Exa (paid).
 * Keys the user configured come first; keyless engines are the fallback.
 *
 * Keyless search engines rate-limit scrapers, so when one shows a challenge we
 * back off from it for a while and never try to solve it.
 */
const DDG_COOLDOWN_KEY = 'route:ddg:challenged';
const DDG_COOLDOWN_SEC = 30 * 60;

/** DuckDuckGo answers suspected bots with a 202 and an image CAPTCHA. */
export function isDdgChallenge(status: number, body: string): boolean {
  return status === 202 || /confirm this search was made by a human|anomaly-modal|bots use DuckDuckGo too/i.test(body);
}
export const webSearchAdapter: Adapter = {
  name: 'websearch',
  priority: 0,

  // Search-only: never claims a URL for fetching.
  match(): boolean {
    return false;
  },

  async fetch(url: URL): Promise<Document> {
    throw new TierError(`websearch does not fetch URLs (${url.href})`, Tier.Native, false);
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const errors: string[] = [];
    const p = ctx.config.providers;

    if (p.searxngUrl) {
      try {
        const r = await searxng(p.searxngUrl, query, ctx, limit);
        if (r.length) return r;
        errors.push('searxng: no results');
      } catch (err) {
        errors.push(`searxng: ${(err as Error).message}`);
      }
    }

    // Keyed providers with monthly free allowances. costOf() is $0 inside the
    // allowance, so the default $0 cap allows them and blocks the first query
    // that would be billed to a card.
    for (const [name, key, run] of [
      ['tavily', p.tavilyKey, tavily],
      ['brave', p.braveKey, brave],
    ] as const) {
      if (!key) continue;
      try {
        const price = await costOf(name, 1);
        if (!ctx.budget.canAfford(price)) {
          errors.push(`${name}: monthly free allowance used up; skipping (raise --max-cost to allow billed queries)`);
          continue;
        }
        ctx.budget.charge(price, `${name} search`);
        const r = await run(key, query, ctx, limit);
        await recordUsage(name, 1);
        if (r.length) return r;
        errors.push(`${name}: no results`);
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
      }
    }

    const cooling = await ctx.cache.get<string>(DDG_COOLDOWN_KEY);
    if (cooling) {
      errors.push(`duckduckgo: skipped, it showed this IP a CAPTCHA at ${cooling.value}; retrying after a 30 min cool-down`);
    } else {
      try {
        const r = await duckduckgo(query, ctx, limit);
        if (r.length) return r;
        errors.push('duckduckgo: no results');
      } catch (err) {
        errors.push(`duckduckgo: ${(err as Error).message}`);
      }
    }

    try {
      const r = await marginalia(query, ctx, limit);
      if (r.length) return r;
      errors.push('marginalia: no results');
    } catch (err) {
      errors.push(`marginalia: ${(err as Error).message}`);
    }


    if (p.exaKey && (ctx.options.maxTier ?? Tier.Headless) >= Tier.Paid) {
      try {
        ctx.budget.charge(PRICES.exaSearch, 'exa search');
        const r = await exa(p.exaKey, query, ctx, limit);
        if (r.length) return r;
      } catch (err) {
        errors.push(`exa: ${(err as Error).message}`);
      }
    }

    throw new TierError(
      `Web search found nothing. Tried:\n  ${errors.join('\n  ')}\n` +
        '  Keyless engines rate-limit heavy use. For reliable search, either:\n' +
        '    • scour auth tavily: free, 1,000 searches/month, no card (https://app.tavily.com)\n' +
        '    • scour auth searxng: self-hosted, no key, no quota',
      Tier.Native,
    );
  },

  async health(ctx: AdapterContext): Promise<HealthReport> {
    const p = ctx.config.providers;
    const keyed = [p.searxngUrl && 'SearXNG', p.tavilyKey && 'Tavily', p.braveKey && 'Brave', p.exaKey && 'Exa'].filter(Boolean) as string[];
    const fix = keyed.length
      ? undefined
      : 'Keyless engines rate-limit heavy use. For reliable search: `scour auth tavily` (free, 1,000/month, no card).';
    const cooling = await ctx.cache.get<string>(DDG_COOLDOWN_KEY);
    let ddg = cooling ? `DuckDuckGo cooling down (CAPTCHA at ${cooling.value})` : 'DuckDuckGo';
    if (!cooling) {
      try {
        if (!(await duckduckgo('test', ctx, 1)).length) ddg = 'DuckDuckGo (returned nothing)';
      } catch (err) {
        ddg = `DuckDuckGo unavailable (${(err as Error).message.split('\n')[0]})`;
      }
    }
    const mg = await marginalia('test', ctx, 1).then((r) => r.length > 0, () => false);
    const ddgOk = ddg === 'DuckDuckGo';
    return {
      adapter: 'websearch',
      status: ddgOk || keyed.length ? 'ready' : mg ? 'degraded' : 'down',
      detail: `${[...keyed, ddg, mg ? 'Marginalia' : 'Marginalia unavailable'].join(' · ')}.`,
      fix,
      capabilities: ddgOk || keyed.length || mg ? ['web search'] : [],
    };
  },
};

async function duckduckgo(query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  // The Lite endpoint returns a small, stable table — far less brittle than the
  // main SERP and much cheaper to parse.
  const res = await ctx.http.post(
    'https://lite.duckduckgo.com/lite/',
    new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
    {
      timeoutMs: ctx.options.timeoutMs,
      contentType: 'application/x-www-form-urlencoded',
      headers: { Referer: 'https://lite.duckduckgo.com/', Origin: 'https://lite.duckduckgo.com' },
      retries: 0,
    },
  );

  if (isDdgChallenge(res.status, res.body)) {
    await ctx.cache.set(DDG_COOLDOWN_KEY, new Date().toISOString().slice(11, 16) + ' UTC', DDG_COOLDOWN_SEC);
    throw new Error('showed a CAPTCHA to this IP (rate-limited); backing off for 30 min');
  }

  const $ = cheerio.load(res.body);
  const out: SearchResult[] = [];
  $('a.result-link').each((_, el) => {
    if (out.length >= limit) return;
    const a = $(el);
    const href = unwrapDdg(a.attr('href') ?? '');
    if (!href) return;
    // The snippet lives in the next row of the results table.
    const snippet = a.closest('tr').next('tr').find('.result-snippet').text().trim();
    out.push({
      title: a.text().trim(),
      url: href,
      snippet: snippet || undefined,
      source: 'web',
    });
  });

  // Fallback selector set for when DDG reshuffles its markup.
  if (out.length === 0) {
    $('a[href]').each((_, el) => {
      if (out.length >= limit) return;
      const href = unwrapDdg($(el).attr('href') ?? '');
      const title = $(el).text().trim();
      if (!href || !title || title.length < 3) return;
      if (/duckduckgo\.com/.test(href)) return;
      out.push({ title, url: href, source: 'web' });
    });
  }
  return out;
}

/** DuckDuckGo wraps outbound links in a redirector; recover the real URL. */
function unwrapDdg(href: string): string | null {
  if (!href) return null;
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs, 'https://lite.duckduckgo.com');
    const target = u.searchParams.get('uddg');
    if (target) return target;
    return /^https?:/.test(u.protocol) && !/duckduckgo\.com$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Marginalia: an independent index with an explicitly public API ("public"
 * key). Smaller and indie-web leaning, so it's a fallback, not the default.
 * Results are licensed CC-BY-NC-SA 4.0 (non-commercial).
 */
async function marginalia(query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const json = await ctx.http.json<{ results?: { url: string; title: string; description?: string }[] }>(
    `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?count=${Math.min(limit, 20)}`,
    { timeoutMs: Math.min(ctx.options.timeoutMs, 10_000), retries: 0 },
  );
  return (json.results ?? []).slice(0, limit).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: truncate(r.description, 300) || undefined,
    source: 'web',
    extra: { engine: 'marginalia', license: 'CC-BY-NC-SA-4.0' },
  }));
}

async function searxng(base: string, query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const u = new URL('/search', base);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  u.searchParams.set('safesearch', '0');
  const json = await ctx.http.json<{ results?: { title: string; url: string; content?: string; publishedDate?: string; engine?: string }[] }>(
    u.href, { timeoutMs: ctx.options.timeoutMs },
  );
  return (json.results ?? []).slice(0, limit).map((r) => ({
    title: r.title, url: r.url, snippet: r.content, source: 'web',
    publishedAt: normDate(r.publishedDate), extra: { engine: r.engine },
  }));
}

/** Pull `site:domain` operators out of a query, for APIs that take domains as a parameter. */
export function splitSiteOperators(query: string): { query: string; domains: string[] } {
  const domains: string[] = [];
  const rest = query.replace(/(?:^|\s)site:(\S+)/gi, (_m, d: string) => {
    domains.push(d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    return ' ';
  });
  return { query: rest.replace(/\s+/g, ' ').trim(), domains };
}

/** Domains that are the same site under two names; filtering on one misses the other. */
const DOMAIN_ALIASES: Record<string, string[]> = { 'x.com': ['twitter.com'], 'twitter.com': ['x.com'] };

type Freshness = 'day' | 'week' | 'month' | 'year';
function freshnessOf(ctx: AdapterContext): Freshness | undefined {
  const f = (ctx.options.adapterOptions as { freshness?: Freshness } | undefined)?.freshness;
  return f && ['day', 'week', 'month', 'year'].includes(f) ? f : undefined;
}

async function tavily(key: string, query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const q = splitSiteOperators(query);
  const fresh = freshnessOf(ctx);
  const domains = [...new Set(q.domains.flatMap((d) => [d, ...(DOMAIN_ALIASES[d] ?? [])]))];
  const call = async (): Promise<SearchResult[]> => {
    const res = await ctx.http.post(
      'https://api.tavily.com/search',
      {
        query: q.query || query,
        max_results: Math.min(Math.max(limit, 1), 20),
        search_depth: 'basic', // 1 credit; "advanced" costs 2
        ...(domains.length ? { include_domains: domains } : {}),
        ...(fresh ? { time_range: fresh } : {}),
      },
      {
        timeoutMs: ctx.options.timeoutMs,
        retries: 0,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      },
    );
    const json = JSON.parse(res.body) as { results?: { title: string; url: string; content?: string; published_date?: string }[] };
    return (json.results ?? []).map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: truncate(r.content?.replace(/\s+/g, ' '), 300) || undefined,
      source: 'web',
      publishedAt: normDate(r.published_date),
      extra: { engine: 'tavily' },
    }));
  };
  let results = await call();
  // Tavily's site-restricted results vary call to call and occasionally come
  // back empty; one retry recovers most of those. It costs one more credit.
  if (results.length === 0 && domains.length) {
    await recordUsage('tavily', 1);
    results = await call();
  }
  return results;
}

async function brave(key: string, query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const json = await ctx.http.json<{ web?: { results?: { title: string; url: string; description?: string; age?: string }[] } }>(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}` +
      (freshnessOf(ctx) ? `&freshness=p${freshnessOf(ctx)![0]}` : ''),
    { timeoutMs: ctx.options.timeoutMs, retries: 0, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
  );
  return (json.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: truncate(r.description?.replace(/<[^>]+>/g, ''), 300),
    source: 'web',
    publishedAt: normDate(r.age),
    extra: { engine: 'brave' },
  }));
}

async function exa(key: string, query: string, ctx: AdapterContext, limit: number): Promise<SearchResult[]> {
  const res = await ctx.http.post(
    'https://api.exa.ai/search',
    { query, numResults: limit, type: 'auto', contents: { text: { maxCharacters: 400 } } },
    { timeoutMs: ctx.options.timeoutMs, headers: { 'x-api-key': key } },
  );
  const json = JSON.parse(res.body) as { results?: { title: string; url: string; text?: string; publishedDate?: string; author?: string }[] };
  return (json.results ?? []).map((r) => ({
    title: r.title, url: r.url, snippet: truncate(r.text, 300), source: 'web',
    publishedAt: normDate(r.publishedDate), author: r.author ? { name: r.author } : undefined,
  }));
}
