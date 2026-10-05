import type { SearchResult } from './types.js';

/**
 * Search query operators, understood the same way on every platform:
 *
 *   ToolMark            a word with capitals inside it is a name: only that
 *                       spelling counts ("toolmark examiners" does not)
 *   "exact phrase"      the words must appear together
 *   -word, -"phrase"    leave out results that mention it
 *   from:handle         only posts by that account (X, Bluesky)
 *
 * Keyword engines get the plain words; the operators are applied to what
 * comes back, so they behave identically whichever engine answered.
 */
export interface ParsedQuery {
  raw: string;
  /** The query for keyword engines: words, phrases (quoted) and site: filters. */
  text: string;
  /** Meaningful words, lowercased. */
  terms: string[];
  /** Quoted phrases, normalised. */
  phrases: string[];
  /** Words and phrases to leave out, normalised. */
  exclude: string[];
  /** Account handles, lowercased, without "@". */
  from: string[];
  /** Words written with inner capitals (ToolMark, OpenAI): matched case-sensitively. */
  exact: string[];
}

export const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'why', 'are', 'you', 'your', 'from', 'that', 'this', 'into', 'about', 'vs', 'site']);

export function parseQuery(raw: string): ParsedQuery {
  const keep: string[] = [];
  const phrases: string[] = [];
  const exclude: string[] = [];
  const from: string[] = [];
  const exact: string[] = [];
  const re = /(^|\s)(-?)(?:([a-z_]+):)?("([^"]*)"?|\S+)/gi;
  for (const m of raw.matchAll(re)) {
    const [, , minus, op, token, quoted] = m as unknown as [string, string, string, string | undefined, string, string | undefined];
    const value = quoted ?? token;
    if (op?.toLowerCase() === 'from') {
      const h = value.replace(/^@/, '').toLowerCase();
      if (/^[\w.-]+$/.test(h)) from.push(h);
      continue;
    }
    if (minus && value.length > 0 && !op) {
      const n = norm(value);
      if (n) exclude.push(n);
      continue;
    }
    if (op) {
      keep.push(`${minus}${op}:${token}`); // site:, lang:… pass through untouched
      continue;
    }
    if (quoted !== undefined) {
      const n = norm(quoted);
      if (n) phrases.push(n);
      keep.push(`"${quoted}"`);
    } else {
      keep.push(token);
    }
    for (const w of value.split(/[^\p{L}\p{N}]+/u)) if (isNameLike(w)) exact.push(w);
  }
  const text = keep.join(' ').trim();
  const terms = norm(text.replace(/\b[a-z_]+:\S+/gi, ' '))
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return { raw, text, terms: [...new Set(terms)], phrases, exclude, from: [...new Set(from)], exact: [...new Set(exact)] };
}

/** "ToolMark", "OpenAI", "iPhone": a lowercase letter followed later by a capital. Not "AI", not "Rust". */
function isNameLike(w: string): boolean {
  return w.length >= 3 && /\p{Ll}.*\p{Lu}/u.test(w);
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Drop platform suffixes that fake word proximity: " : r/OpenAI - Reddit", " / X". */
export function cleanTitle(t: string): string {
  return t
    .replace(/\s*[-–|]\s*(Reddit|YouTube|X|Twitter|Hacker News|GitHub)\s*$/i, '')
    .replace(/\s*:\s*r\/\w+\s*$/i, '')
    .replace(/\s*\/\s*X\s*$/, '');
}

export type MissReason = 'excluded' | 'author' | 'spelling' | 'missing' | 'scattered';

export interface MatchOptions {
  /**
   * The snippet is the whole post (tweets, Bluesky posts), so a term that is
   * absent really is absent. Otherwise only contradicting evidence (a
   * different spelling, an excluded word) removes a result.
   */
  complete: boolean;
}

/**
 * Does a result satisfy the query? Returns why not, so callers can explain
 * what they hid ("10 posts said 'toolmark', not 'ToolMark'").
 */
export function matchQuery(r: SearchResult, q: ParsedQuery, opts: MatchOptions): { ok: true } | { ok: false; reason: MissReason } {
  const body = [cleanTitle(r.title ?? ''), r.snippet ?? ''].join('\n');
  const bodyNorm = norm(body);
  const words = bodyNorm.split(' ');
  const handle = (r.author?.handle ?? '').toLowerCase().replace(/^@/, '');
  const nameWords = norm(r.author?.name ?? '').split(' ');
  // A post by @OpenAI is about OpenAI without saying so. Short words don't
  // count inside handles ("ai" is in half of them).
  const byAuthor = (t: string) => handle === t.replace(/\s+/g, '') || (t.length >= 4 && handle.includes(t.replace(/\s+/g, ''))) || ` ${nameWords.join(' ')} `.includes(` ${t} `);

  if (q.from.length && !q.from.includes(handle)) return { ok: false, reason: 'author' };

  for (const x of q.exclude) {
    if (x.includes(' ') ? ` ${bodyNorm} `.includes(` ${x} `) : words.some((w) => w.startsWith(x))) return { ok: false, reason: 'excluded' };
  }

  // Names: the exact spelling, ALL CAPS, or inside a handle/domain (case-free there).
  for (const name of q.exact) {
    const v = spellingOf(body, name);
    if (v === 'exact' || handle.includes(name.toLowerCase()) || (r.author?.name ?? '').includes(name)) continue;
    if (v === 'other') return { ok: false, reason: 'spelling' };
    if (opts.complete) return { ok: false, reason: 'missing' };
  }

  for (const p of q.phrases) {
    if (` ${bodyNorm} `.includes(` ${p} `)) continue;
    if (opts.complete && !byAuthor(p)) return { ok: false, reason: 'missing' };
  }

  if (!opts.complete) return { ok: true };

  // Every other term must be in the post, close together. A term the author's
  // handle or name already carries ("OpenAI" for @OpenAI) needs no mention.
  const terms = q.terms.filter((t) => !byAuthor(t));
  if (terms.length === 0) return { ok: true };
  if (terms.length === 1) return words.some((w) => w === terms[0] || w.startsWith(terms[0]!)) ? { ok: true } : { ok: false, reason: 'missing' };
  const near = [cleanTitle(r.title ?? ''), r.snippet ?? ''].map((f) => span(norm(f).split(' '), terms));
  if (near.some((s) => s < terms.length + 3)) return { ok: true };
  return { ok: false, reason: near.some((s) => s < Infinity) ? 'scattered' : 'missing' };
}

/** Smallest window (in words) that contains every term; Infinity if one is absent. */
function span(words: string[], terms: string[]): number {
  const positions = terms.map((t) => words.map((w, i) => (w === t || w.startsWith(t) ? i : -1)).filter((i) => i >= 0));
  if (positions.some((p) => p.length === 0)) return Infinity;
  let best = Infinity;
  for (const start of positions[0]!) {
    const picks = positions.slice(1).map((p) => p.reduce((b, i) => (Math.abs(i - start) < Math.abs(b - start) ? i : b)));
    best = Math.min(best, Math.max(start, ...picks) - Math.min(start, ...picks));
  }
  return best;
}

/**
 * How a name appears in text: 'exact' (ToolMark, TOOLMARK, @toolmarkai,
 * toolmark.ai), 'other' (only as toolmark/Toolmark), or 'absent'.
 */
export function spellingOf(text: string, name: string): 'exact' | 'other' | 'absent' {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])([@#]?)(${escape(name)})([\\p{L}\\p{N}_]*)(\\.[a-z]{2,})?`, 'giu');
  let seen = false;
  for (const m of text.matchAll(re)) {
    seen = true;
    const [, before, sigil, word, tail, domain] = m as unknown as [string, string, string, string, string, string | undefined];
    if (word === name || word === name.toUpperCase()) return 'exact';
    // Handles, domains and URL paths are case-free: @toolmarkai, toolmark.ai, github.com/x/toolmark.
    if (sigil === '@' || (domain && !tail) || (before === '/' && inUrl(text, m.index! + 1))) return 'exact';
  }
  return seen ? 'other' : 'absent';
}

/** Is position `i` inside a URL-looking token (github.com/x/…, https://…)? "DNA/toolmark" is not. */
function inUrl(text: string, i: number): boolean {
  const head = text.slice(0, i);
  const token = head.slice(head.search(/\S*$/));
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\//i.test(token);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One-line explanations of what a filter hid, for people. */
export function describeHidden(q: ParsedQuery, hidden: Partial<Record<MissReason, number>>): string[] {
  const notes: string[] = [];
  const n = (k: MissReason) => hidden[k] ?? 0;
  if (n('spelling')) {
    const names = q.exact.map((e) => `"${e}"`).join(', ');
    const lower = q.exact.map((e) => e.toLowerCase()).join(' ');
    notes.push(
      `Hid ${n('spelling')} ${plural(n('spelling'), 'result')} that ${n('spelling') === 1 ? 'spells' : 'spell'} ${names} differently (usually a different meaning). ` +
        `Type "${lower}" in lowercase to include every spelling.`,
    );
  }
  const off = n('missing') + n('scattered');
  if (off) notes.push(`Hid ${off} ${plural(off, 'result')} the search engines returned that ${off === 1 ? "doesn't" : "don't"} actually mention the query.`);
  if (n('excluded')) notes.push(`Left out ${n('excluded')} ${plural(n('excluded'), 'result')} with ${q.exclude.map((x) => `"${x}"`).join(', ')}.`);
  if (n('author')) notes.push(`Left out ${n('author')} ${plural(n('author'), 'post')} by other accounts.`);
  return notes;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
