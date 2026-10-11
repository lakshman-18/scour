import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { configHome } from '../core/config.js';
import type { Scour } from '../core/pipeline.js';
import type { FetchOptions } from '../core/types.js';
import { extractRecords, pageHtml } from './extract.js';

/**
 * Scraping by example (the AutoScraper idea) with rules that repair
 * themselves (the Scrapling idea).
 *
 * Learn: you give values you can see on the page ("What are metaclasses in
 * Python?", or price=$19.99). scour finds the elements holding them, climbs to
 * the repeating item that contains them (a row, a card), and writes plain CSS
 * selectors that pull every similar item. No selector knowledge needed, and
 * the selectors are printed so they can be reused anywhere.
 *
 * Repair: a saved rule keeps a fingerprint of the elements it learned. When
 * the site changes and the selectors stop matching, scour scores every element
 * on the new page against the fingerprints, picks the most similar repeating
 * structure, rebuilds the selectors, and says it did.
 */
export interface LearnedRule {
  name?: string;
  url: string;
  list?: string;
  fields: Record<string, string>;
  prints?: { item?: Print; fields: Record<string, Print> };
  learnedAt: string;
  repairedAt?: string;
}

interface Print {
  tag: string;
  classes: string[];
  attrs: string[];
  parentTag: string;
  parentClasses: string[];
  childTags: string[];
  /** What the text looks like: money, number, date, url, words-1…words-many. */
  shape?: string;
  /** Position among its element siblings. */
  pos?: number;
}

export interface LearnResult {
  rule: LearnedRule;
  records: Record<string, string | null>[];
  /** Examples that could not be found on the page. */
  missing: string[];
}

// ------------------------------------------------------------------ learning

/** `examples`: plain values ("Some title") or named ones ("price=$19.99"). */
export function learnFromHtml(html: string, url: string, examples: string[]): LearnResult {
  const $ = cheerio.load(html);
  const named = examples.map((e) => {
    const m = /^([A-Za-z_][\w-]{0,30})=(.+)$/s.exec(e);
    return m ? { field: m[1]!, value: m[2]!.trim() } : { field: 'value', value: e.trim() };
  });
  const byField = new Map<string, string[]>();
  for (const n of named) byField.set(n.field, [...(byField.get(n.field) ?? []), n.value]);

  const missing: string[] = [];
  const found = new Map<string, { el: Element; attr?: string }[]>();
  for (const [field, values] of byField) {
    for (const v of values) {
      const hit = locate($, v, url);
      if (hit) found.set(field, [...(found.get(field) ?? []), hit]);
      else missing.push(v);
    }
  }
  if (!found.size) return { rule: { url, fields: {}, learnedAt: new Date().toISOString() }, records: [], missing };

  // The repeating item: climb from the first example until the element has
  // siblings built the same way; it must contain every field's example.
  // The repeating item: climb from the first example until the element has
  // look-alike siblings that each hold the same field. Examples for other
  // fields may come from different items (a title from one row, a link from
  // another); each is mapped through its own copy of the item.
  const first = [...found.values()][0]![0]!.el;
  let item: Element | undefined;
  for (const node of [first, ...ancestors(first)]) {
    if (node.tagName === 'body' || node.tagName === 'html') break;
    if (repeats($, node) && holdsField($, node, [first])) {
      item = node;
      break;
    }
  }
  const itemOf = (el: Element): Element | undefined => {
    if (!item) return undefined;
    const s = sig(item);
    const parent = item.parent;
    return [el, ...ancestors(el)].find((n) => sig(n) === s && n.parent === parent);
  };

  const fields: Record<string, string> = {};
  const prints: Record<string, Print> = {};
  let list: string | undefined;
  if (item) {
    list = listSelector($, item);
    for (const [field, hits] of found) {
      const h = hits[0]!;
      const own = itemOf(h.el);
      if (!own) {
        missing.push(`${field} (not inside the repeating items)`);
        continue;
      }
      const rel = h.el === own ? '' : relPath($, own, h.el);
      fields[field] = `${rel}${h.attr ? `@${h.attr}` : ''}`;
      prints[field] = print($, h.el);
    }
    // Several examples for one field must all be found; loosen classes if not.
    const records = extractRecords(html, url, { list, fields });
    for (const [field, values] of byField) {
      if (!fields[field] && fields[field] !== '') continue;
      if (!values.every((v) => records.some((r) => same(r[field], v)))) {
        const h = found.get(field)![0]!;
        const loose = relPath($, itemOf(h.el)!, h.el, true);
        fields[field] = `${loose}${h.attr ? `@${h.attr}` : ''}`;
      }
    }
  } else {
    // Nothing repeats: a single value per field, by an absolute selector.
    for (const [field, hits] of found) {
      fields[field] = `${absolutePath($, hits[0]!.el)}${hits[0]!.attr ? `@${hits[0]!.attr}` : ''}`;
      prints[field] = print($, hits[0]!.el);
    }
  }
  const rule: LearnedRule = { url, list, fields, prints: { item: item ? print($, item) : undefined, fields: prints }, learnedAt: new Date().toISOString() };
  return { rule, records: extractRecords(html, url, { list, fields }), missing };
}

/** The smallest element whose text is the value (or whose link points to it). */
function locate($: cheerio.CheerioAPI, value: string, base: string): { el: Element; attr?: string } | null {
  if (/^https?:\/\//i.test(value)) {
    for (const attr of ['href', 'src']) {
      const el = $(`[${attr}]`).toArray().find((e) => {
        try {
          return new URL($(e).attr(attr)!, base).href === new URL(value).href;
        } catch {
          return false;
        }
      });
      if (el) return { el: el as Element, attr };
    }
  }
  const want = norm(value);
  const exact: Element[] = [];
  const contains: Element[] = [];
  $('body *').each((_i, node) => {
    const el = node as Element;
    if (['script', 'style', 'noscript', 'svg', 'template'].includes(el.tagName)) return;
    const text = norm($(el).text());
    if (text === want) exact.push(el);
    else if (want.length >= 6 && text.includes(want)) contains.push(el);
  });
  // The innermost element holding the value, first on the page.
  const innermost = (list: Element[]) => list.find((el) => !list.some((o) => o !== el && isAncestor(el, o)));
  const el = innermost(exact) ?? innermost(contains);
  return el ? { el } : null;
}

// ------------------------------------------------------------------ selectors

/** Classes worth keeping in a selector: not generated hashes (css-1x9f, sc-abc12, _3kXy). */
function stableClasses(el: Element): string[] {
  return (el.attribs?.class ?? '')
    .split(/\s+/)
    .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !/\d{3,}/.test(c) && !/^(css|sc|jsx|svelte|emotion|tw)-/.test(c) && c.length < 40)
    .slice(0, 3);
}

function sig(el: Element, loose = false): string {
  const tag = el.tagName;
  if (loose) return tag;
  const cls = stableClasses(el);
  if (cls.length) return `${tag}${cls.map((c) => `.${c}`).join('')}`;
  for (const a of ['itemprop', 'data-testid', 'role']) {
    const v = el.attribs?.[a];
    if (v && /^[\w -]{1,40}$/.test(v)) return `${tag}[${a}="${v}"]`;
  }
  return tag;
}

/**
 * A real repeating item has the field in most of its look-alike siblings.
 * On Hacker News the rank cell and the title cell are both td.title; only
 * the row (tr.athing) has a headline in every copy.
 */
function holdsField($: cheerio.CheerioAPI, node: Element, targets: Element[]): boolean {
  const parent = node.parent as Element | null;
  if (!parent) return false;
  const s = sig(node);
  const siblings = parent.children.filter((c) => (c as Element).tagName && sig(c as Element) === s) as Element[];
  return targets.every((t) => {
    if (t === node) return true;
    const rel = relPath($, node, t);
    const hits = siblings.filter((sib) => $(sib).find(rel).length > 0).length;
    return hits >= Math.max(2, Math.ceil(siblings.length * 0.5));
  });
}

function repeats($: cheerio.CheerioAPI, el: Element): boolean {
  const parent = el.parent as Element | null;
  if (!parent || !('children' in parent)) return false;
  const s = sig(el);
  return parent.children.filter((c) => (c as Element).tagName && sig(c as Element) === s).length >= 2;
}

function listSelector($: cheerio.CheerioAPI, item: Element): string {
  const own = sig(item);
  const parent = item.parent as Element | null;
  const scoped = parent && parent.tagName !== 'body' ? `${sig(parent)} > ${own}` : own;
  // Prefer the scoped form only if it still finds every sibling.
  const all = $(own).length;
  return $(scoped).length >= 2 && $(scoped).length <= all ? scoped : own;
}

/** Selector from `item` down to `el`, one signature per level. */
function relPath($: cheerio.CheerioAPI, item: Element, el: Element, loose = false): string {
  const chain: Element[] = [];
  for (let n: Element | null = el; n && n !== item; n = n.parent as Element | null) chain.unshift(n);
  // Short paths are sturdier: keep the last two levels, unless that becomes ambiguous within the item.
  for (let keep = 1; keep <= chain.length; keep++) {
    const sel = chain.slice(-keep).map((n, i, arr) => sig(n, loose && i < arr.length - 1)).join(' ');
    const matches = $(item).find(sel);
    if (matches.length >= 1 && matches.first()[0] === el) return sel;
  }
  return chain.map((n) => sig(n, loose)).join(' > ');
}

function absolutePath($: cheerio.CheerioAPI, el: Element): string {
  if (el.attribs?.id && /^[A-Za-z][\w-]*$/.test(el.attribs.id)) return `#${el.attribs.id}`;
  const chain = [el, ...ancestors(el)].filter((n) => n.tagName !== 'html' && n.tagName !== 'body').slice(0, 4).reverse();
  for (let start = chain.length - 1; start >= 0; start--) {
    const sel = chain.slice(start).map((n) => sig(n)).join(' ');
    if ($(sel).first()[0] === el) return sel;
  }
  return chain.map((n) => sig(n)).join(' > ');
}

// ------------------------------------------------------------------ repair

function print($: cheerio.CheerioAPI, el: Element): Print {
  const parent = el.parent as Element | null;
  return {
    tag: el.tagName,
    classes: stableClasses(el),
    attrs: Object.keys(el.attribs ?? {}).filter((a) => a !== 'class' && a !== 'style').sort(),
    parentTag: parent?.tagName ?? '',
    parentClasses: parent ? stableClasses(parent) : [],
    childTags: $(el).children().toArray().map((c) => (c as Element).tagName).slice(0, 12),
    shape: shapeOf($(el).text()),
    pos: parent ? parent.children.filter((c) => (c as Element).tagName).indexOf(el) : 0,
  };
}

function shapeOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'empty';
  if (/^[$€£¥₹]\s?\d|^\d[\d,.]*\s?(usd|eur|€|\$)$/i.test(t)) return 'money';
  if (/^[\d,.]+%?$/.test(t)) return 'number';
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d+\s+(minutes?|hours?|days?)\s+ago$/i.test(t)) return 'date';
  if (/^https?:\/\//.test(t)) return 'url';
  const words = t.split(' ').length;
  return words <= 2 ? 'words-few' : words <= 12 ? 'words-some' : 'words-many';
}

function similarity(a: Print, b: Print): number {
  const jac = (x: string[], y: string[]) => {
    if (!x.length && !y.length) return 1;
    const sx = new Set(x);
    const inter = y.filter((v) => sx.has(v)).length;
    return inter / new Set([...x, ...y]).size;
  };
  return (
    (a.tag === b.tag ? 2 : 0) +
    3 * jac(a.classes, b.classes) +
    jac(a.attrs, b.attrs) +
    (a.parentTag === b.parentTag ? 1 : 0) +
    jac(a.parentClasses, b.parentClasses) +
    1.5 * jac(a.childTags, b.childTags) +
    (a.shape && a.shape === b.shape ? 2 : 0) +
    (a.pos !== undefined && a.pos === b.pos ? 0.5 : 0)
  ) / 12;
}

/**
 * Run a rule; if its selectors no longer match, relocate the items by
 * similarity to the fingerprints and rebuild the selectors.
 */
export function applyRule(html: string, url: string, rule: LearnedRule): { records: Record<string, string | null>[]; repaired?: { rule: LearnedRule; score: number } } {
  const records = extractRecords(html, url, { list: rule.list, fields: rule.fields });
  const useful = records.filter((r) => Object.values(r).some((v) => v !== null));
  if (useful.length || !rule.prints?.item || !rule.list) return { records: useful };

  const $ = cheerio.load(html);
  let best: { el: Element; score: number } | null = null;
  $('body *').each((_i, node) => {
    const el = node as Element;
    if (!repeats($, el)) return;
    const score = similarity(rule.prints!.item!, print($, el));
    if (!best || score > best.score) best = { el, score };
  });
  const found = best as { el: Element; score: number } | null;
  if (!found || found.score < 0.55) return { records: [] };

  const item = found.el;
  const fields: Record<string, string> = {};
  for (const [field, sel] of Object.entries(rule.fields)) {
    const attr = sel.includes('@') ? sel.slice(sel.lastIndexOf('@') + 1) : undefined;
    const target = rule.prints.fields[field];
    if (!target) continue;
    let pick: { el: Element; score: number } | null = null;
    for (const node of [item, ...$(item).find('*').toArray()]) {
      const el = node as Element;
      if (attr && !el.attribs?.[attr]) continue;
      const score = similarity(target, print($, el));
      if (!pick || score > pick.score) pick = { el, score };
    }
    if (pick) fields[field] = `${pick.el === item ? '' : relPath($, item, pick.el)}${attr ? `@${attr}` : ''}`;
  }
  const list = listSelector($, item);
  const repairedRecords = extractRecords(html, url, { list, fields }).filter((r) => Object.values(r).some((v) => v !== null));
  if (!repairedRecords.length) return { records: [] };
  const repaired: LearnedRule = {
    ...rule, list, fields,
    prints: {
      item: print($, item),
      fields: Object.fromEntries(Object.entries(fields).map(([f, sel]) => {
        const css = sel.split('@')[0];
        return [f, print($, css ? (($(item).find(css).first()[0] as Element | undefined) ?? item) : item)];
      })),
    },
    repairedAt: new Date().toISOString(),
  };
  return { records: repairedRecords, repaired: { rule: repaired, score: Math.round(found.score * 100) / 100 } };
}

// ------------------------------------------------------------------ fetch + store

export async function learn(scour: Scour, url: string, examples: string[], options?: FetchOptions): Promise<LearnResult & { tier: string }> {
  let page = await pageHtml(scour, url, options);
  let res = learnFromHtml(page.html, page.url, examples);
  if (res.missing.length && page.tier !== 'headless') {
    // The values may only appear after JavaScript runs.
    const rendered = await pageHtml(scour, url, options, { render: true }).catch(() => null);
    if (rendered) {
      const again = learnFromHtml(rendered.html, rendered.url, examples);
      if (again.missing.length < res.missing.length) {
        page = rendered;
        res = again;
      }
    }
  }
  return { ...res, tier: page.tier };
}

export async function runRule(scour: Scour, url: string, rule: LearnedRule, options?: FetchOptions) {
  let page = await pageHtml(scour, url, options);
  let out = applyRule(page.html, page.url, rule);
  if (!out.records.length && page.tier !== 'headless') {
    const rendered = await pageHtml(scour, url, options, { render: true }).catch(() => null);
    if (rendered) {
      page = rendered;
      out = applyRule(page.html, page.url, rule);
    }
  }
  return { ...out, tier: page.tier, url: page.url };
}

function rulesDir(): string {
  return path.join(configHome(), 'rules');
}

export async function saveRule(name: string, rule: LearnedRule): Promise<string> {
  if (!/^[\w-]{1,60}$/.test(name)) throw new Error('Rule names use letters, digits, - and _');
  await fs.mkdir(rulesDir(), { recursive: true, mode: 0o700 });
  const file = path.join(rulesDir(), `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ ...rule, name }, null, 2), { mode: 0o600 });
  return file;
}

export async function loadRule(name: string): Promise<LearnedRule> {
  try {
    return JSON.parse(await fs.readFile(path.join(rulesDir(), `${name}.json`), 'utf-8')) as LearnedRule;
  } catch {
    throw new Error(`No saved rule "${name}". Make one with: scour extract <url> --example "<a value on the page>" --save ${name}`);
  }
}

export async function listRules(): Promise<LearnedRule[]> {
  const names = await fs.readdir(rulesDir()).catch(() => [] as string[]);
  const out: LearnedRule[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(rulesDir(), n), 'utf-8')) as LearnedRule);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function ancestors(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.parent as Element | null; n && (n as AnyNode).type === 'tag'; n = n.parent as Element | null) out.push(n);
  return out;
}

function isAncestor(a: Element, b: Element): boolean {
  for (let n = b.parent as Element | null; n; n = n.parent as Element | null) if (n === a) return true;
  return false;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function same(a: string | null | undefined, b: string): boolean {
  return !!a && (norm(a) === norm(b) || norm(a).includes(norm(b)));
}
