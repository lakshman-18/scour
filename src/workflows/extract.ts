import * as cheerio from 'cheerio';
import type { Scour } from '../core/pipeline.js';
import { normaliseUrl } from '../core/pipeline.js';
import { Tier, type FetchOptions } from '../core/types.js';

export interface StructuredSpec {
  /** field name → CSS selector. Append `@attr` to read an attribute: `link=a@href`. */
  fields: Record<string, string>;
  /** When set, emit one record per element matching this selector. */
  list?: string;
  /** Default attribute to read for every field (otherwise text). */
  attr?: string;
  options?: FetchOptions;
}

export interface StructuredResult {
  url: string;
  count: number;
  records: Record<string, string | null>[];
  tier: string;
}

/**
 * Deterministic structured extraction: CSS selectors in, JSON records out.
 *
 * This is the part paid scrapers charge most for. Doing it with selectors
 * instead of an LLM means it is free, instant and gives the same answer every
 * run — which is what you want inside a pipeline.
 */
export async function extractStructured(scour: Scour, url: string, spec: StructuredSpec): Promise<StructuredResult> {
  const firstSel = spec.list ?? Object.values(spec.fields)[0]?.split('@')[0];
  let page = await pageHtml(scour, url, spec.options);
  let records = page.html ? extractRecords(page.html, page.url, spec) : [];
  const empty = records.length === 0 || records.every((r) => Object.values(r).every((v) => v === null));
  if (empty && page.tier !== 'headless') {
    const rendered = await pageHtml(scour, url, spec.options, { render: true, waitForSelector: firstSel }).catch(() => null);
    if (rendered?.html) {
      page = rendered;
      records = extractRecords(page.html, page.url, spec);
    }
  }
  return { url: page.url, count: records.length, records, tier: page.tier };
}

/**
 * A page's raw HTML (selectors need markup, not Markdown): cache, then a
 * plain fetch, then a browser when asked to render or when the plain fetch
 * failed. A saved login for the site (scour login) is used for the browser.
 */
export async function pageHtml(
  scour: Scour,
  url: string,
  options: FetchOptions = {},
  how: { render?: boolean; waitForSelector?: string } = {},
): Promise<{ html: string; url: string; tier: 'cache' | 'static' | 'headless' }> {
  const u = normaliseUrl(url);
  const maxTier = options.maxTier ?? scour.config.maxTier;
  const key = `html:${u.href}`;
  const { sessionForHost } = await import('../render/sessions.js');
  const session = await sessionForHost(u.hostname);
  if (!how.render && !session) {
    const cached = await scour.cache.get<string>(key, options.noCache ? 0 : options.ttl);
    if (cached) return { html: cached.value, url: u.href, tier: 'cache' };
    try {
      const res = await (scour as unknown as { http: { get(u: string, i?: unknown): Promise<{ body: string; url: string }> } }).http.get(u.href, {
        timeoutMs: options.timeoutMs ?? scour.config.timeoutMs,
      });
      await scour.cache.set(key, res.body, options.ttl ?? scour.config.defaultTtlSec);
      return { html: res.body, url: res.url || u.href, tier: 'static' };
    } catch (err) {
      scour.log.debug(`static fetch failed for extract: ${(err as Error).message}`);
      if (maxTier < Tier.Headless) throw err;
    }
  }
  if (maxTier < Tier.Headless) throw new Error(`Rendering ${u.href} needs --max-tier headless.`);
  const { renderPage } = await import('../render/browser.js');
  const page = await renderPage(u.href, {
    userAgent: scour.config.userAgent, proxy: scour.config.proxy,
    log: scour.log, timeoutMs: scour.config.timeoutMs,
  }, {
    waitForSelector: how.waitForSelector, waitUntil: 'domcontentloaded', scroll: 1,
    ...(session ? { session: { key: session.key, dir: session.dir, channel: session.meta.channel } } : {}),
  });
  return { html: page.html, url: page.url, tier: 'headless' };
}

export function extractRecords(html: string, base: string, spec: Pick<StructuredSpec, 'fields' | 'list' | 'attr'>): Record<string, string | null>[] {
  const $ = cheerio.load(html);
  const read = (scope: cheerio.Cheerio<any>, raw: string): string | null => {
    const [sel, attrOverride] = raw.split('@');
    const attr = attrOverride ?? spec.attr;
    const el = sel ? scope.find(sel).first() : scope;
    if (!el.length) return null;
    if (attr) {
      const v = el.attr(attr);
      if (!v) return null;
      // Resolve relative links so the output is usable as-is.
      if (/^(href|src|action|data-src)$/.test(attr)) {
        try { return new URL(v, base).href; } catch { return v; }
      }
      return v.trim();
    }
    const t = el.text().replace(/\s+/g, ' ').trim();
    return t || null;
  };

  if (spec.list) {
    return $(spec.list)
      .toArray()
      .map((el) => {
        const scope = $(el);
        const rec: Record<string, string | null> = {};
        for (const [k, sel] of Object.entries(spec.fields)) rec[k] = read(scope, sel);
        return rec;
      });
  }

  const root = $.root();
  const rec: Record<string, string | null> = {};
  for (const [k, sel] of Object.entries(spec.fields)) rec[k] = read(root, sel);
  return [rec];
}
