import { STOPWORDS } from './query.js';

/**
 * Query-focused Markdown (Crawl4AI calls it "fit markdown"): keep only the
 * parts of a page that are about the question, so an AI reads 5 relevant
 * paragraphs instead of 50. Blocks (paragraphs, lists, tables, code) are
 * ranked with BM25 against the question; the best ones are kept in their
 * original order, each under its section heading, with "…" where text was
 * left out. Deterministic and free: no model involved.
 */
export interface FocusResult {
  text: string;
  /** Blocks kept, of all blocks. 0 kept means nothing matched and `text` is the original. */
  kept: number;
  total: number;
}

interface Block {
  kind: 'heading' | 'body';
  level: number;
  text: string;
  /** Index of the heading this block sits under. */
  section: number;
}

export function focusMarkdown(md: string, question: string, opts: { budgetChars?: number } = {}): FocusResult {
  const blocks = splitBlocks(md);
  const body = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.kind === 'body');
  const q = [...new Set(tokens(question))];
  if (!q.length || body.length < 3) return { text: md, kept: 0, total: body.length };

  // BM25 over blocks; each block also "contains" its section heading, which
  // is usually what tells you a paragraph is the relevant one.
  const docs = body.map(({ b }) => tokens(`${b.text} ${b.section >= 0 ? blocks[b.section]!.text : ''}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scores = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    return q.reduce((s, t) => {
      const f = tf.get(t) ?? 0;
      if (!f) return s;
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      return s + (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }, 0);
  });
  const top = Math.max(...scores);
  if (top <= 0) return { text: md, kept: 0, total: body.length };

  const totalChars = body.reduce((n, x) => n + x.b.text.length, 0);
  const budget = opts.budgetChars ?? Math.max(1500, Math.round(totalChars * 0.35));
  const ranked = scores
    .map((s, j) => ({ s, j }))
    .filter((x) => x.s >= top * 0.25)
    .sort((x, y) => y.s - x.s);
  const keep = new Set<number>();
  let used = 0;
  for (const { j } of ranked) {
    const len = body[j]!.b.text.length;
    if (keep.size >= 3 && used + len > budget) continue;
    keep.add(body[j]!.i);
    used += len;
  }

  // Original order, each kept block under its heading, gaps marked.
  const out: string[] = [];
  const headed = new Set<number>();
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (!keep.has(i)) continue;
    const sec = blocks[i]!.section;
    if (sec >= 0 && !headed.has(sec)) {
      if (last >= 0 && sec > last + 1) out.push('…');
      out.push(blocks[sec]!.text);
      headed.add(sec);
      last = sec;
    }
    if (last >= 0 && i > last + 1 && out.at(-1) !== '…') out.push('…');
    out.push(blocks[i]!.text);
    last = i;
  }
  if (last < blocks.length - 1) out.push('…');
  return { text: out.join('\n\n'), kept: keep.size, total: body.length };
}

/** Paragraphs, list runs, tables and code fences stay whole; headings are their own blocks. */
function splitBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let section = -1;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) blocks.push({ kind: 'body', level: 0, text, section });
    buf = [];
  };
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const fence = [line];
      for (i++; i < lines.length; i++) {
        fence.push(lines[i]!);
        if (/^```/.test(lines[i]!)) break;
      }
      buf = fence;
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1]!.length, text: line.trim(), section: -1 });
      section = blocks.length - 1;
      continue;
    }
    if (!line.trim()) {
      // Lists and tables continue across single blank lines only if the next line continues them.
      const next = lines[i + 1] ?? '';
      const listy = /^\s*([-*+]|\d+\.)\s/.test(buf.at(-1) ?? '') && /^\s*([-*+]|\d+\.)\s/.test(next);
      if (!listy) flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(stem);
}

/** Light stemming so "agents" matches "agent" and "pricing" matches "price". */
function stem(t: string): string {
  if (t.length <= 4) return t;
  return t.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
}
