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
  const u = normaliseUrl(url);
  const maxTier = spec.options?.maxTier ?? scour.config.maxTier;

  // Raw HTML is needed here, not the readable Markdown, so go straight to HTTP
  // and only render when the static page clearly doesn't contain the targets.
  let html = '';
  let tier = 'static';
  try {
    const cached = await scour.cache.get<string>(`html:${u.href}`, spec.options?.noCache ? 0 : spec.options?.ttl);
    if (cached) {
      html = cached.value;
      tier = 'cache';
    } else {
      const res = await (scour as unknown as { http: { get(u: string, i?: unknown): Promise<{ body: string }> } }).http.get(u.href, {
        timeoutMs: spec.options?.timeoutMs ?? scour.config.timeoutMs,
      });
      html = res.body;
    }
  } catch (err) {
    scour.log.debug(`static fetch failed for extract: ${(err as Error).message}`);
  }

  let records = html ? run(html, u.href, spec) : [];
  const empty = records.length === 0 || records.every((r) => Object.values(r).every((v) => v === null));

  if (empty && maxTier >= Tier.Headless) {
    const { renderPage } = await import('../render/browser.js');
    const firstSel = spec.list ?? Object.values(spec.fields)[0]?.split('@')[0];
    const page = await renderPage(u.href, {
      userAgent: scour.config.userAgent, proxy: scour.config.proxy,
      log: scour.log, timeoutMs: scour.config.timeoutMs,
    }, { waitForSelector: firstSel, waitUntil: 'domcontentloaded', scroll: 1 });
    html = page.html;
    tier = 'headless';
    records = run(html, u.href, spec);
  }

  if (html && tier !== 'cache') await scour.cache.set(`html:${u.href}`, html, spec.options?.ttl ?? scour.config.defaultTtlSec);

  return { url: u.href, count: records.length, records, tier };
}

function run(html: string, base: string, spec: StructuredSpec): Record<string, string | null>[] {
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
