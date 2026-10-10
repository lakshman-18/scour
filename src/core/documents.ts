import { extractFromHtml, tidy } from './extract.js';

/**
 * Files → Markdown, locally and free (what Microsoft's MarkItDown does, in
 * process): PDF via pdf.js (unpdf), Word via mammoth, and PowerPoint, Excel,
 * EPUB and CSV/TSV read straight from their XML/text. Nothing is uploaded.
 */
export interface ConvertedDocument {
  title?: string;
  author?: string;
  text: string;
  pages?: number;
  publishedAt?: string;
  format: DocFormat;
}

export type DocFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'epub' | 'csv' | 'tsv';

export function documentFormat(contentType: string, url: string): DocFormat | null {
  const ext = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  if (/application\/pdf/i.test(contentType) || ext === 'pdf') return 'pdf';
  if (/officedocument\.wordprocessingml/i.test(contentType) || ext === 'docx') return 'docx';
  if (/officedocument\.presentationml/i.test(contentType) || ext === 'pptx') return 'pptx';
  if (/officedocument\.spreadsheetml/i.test(contentType) || ext === 'xlsx') return 'xlsx';
  if (/application\/epub\+zip/i.test(contentType) || ext === 'epub') return 'epub';
  if (/text\/csv/i.test(contentType) || ext === 'csv') return 'csv';
  if (/text\/tab-separated-values/i.test(contentType) || ext === 'tsv') return 'tsv';
  return null;
}

export async function convertDocument(raw: Buffer, format: DocFormat, opts: { maxPages?: number; maxRows?: number } = {}): Promise<ConvertedDocument> {
  switch (format) {
    case 'pdf': return pdfToMarkdown(raw, opts.maxPages);
    case 'docx': return docxToMarkdown(raw);
    case 'pptx': return pptxToMarkdown(raw);
    case 'xlsx': return xlsxToMarkdown(raw, opts.maxRows);
    case 'epub': return epubToMarkdown(raw);
    case 'csv':
    case 'tsv': return delimitedToMarkdown(raw.toString('utf-8'), format, opts.maxRows);
  }
}

async function pdfToMarkdown(raw: Buffer, maxPages = 200): Promise<ConvertedDocument> {
  const { getDocumentProxy, extractText, getMeta } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(raw));
  const [{ totalPages, text }, meta] = await Promise.all([
    extractText(pdf, { mergePages: false }),
    getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> })),
  ]);
  const pages = (text as string[]).slice(0, maxPages);
  const body = pages
    .map((p, i) => {
      const clean = p
        .replace(/-\n(?=[a-z])/g, '') // re-join hyphenated line breaks
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return pages.length > 1 ? `<!-- page ${i + 1} -->\n${clean}` : clean;
    })
    .join('\n\n');
  const info = (meta as { info?: Record<string, unknown> }).info ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const truncated = totalPages > pages.length ? `\n\n…[stopped after ${pages.length} of ${totalPages} pages]` : '';
  return {
    title: str(info.Title),
    author: str(info.Author),
    text: tidy(body) + truncated,
    pages: totalPages,
    publishedAt: pdfDate(str(info.CreationDate)),
    format: 'pdf',
  };
}

async function docxToMarkdown(raw: Buffer): Promise<ConvertedDocument> {
  const mod = await import('mammoth');
  const mammoth = (mod.default ?? mod) as typeof mod;
  // Embedded pictures would otherwise arrive as huge base64 data URIs.
  const { value: html } = await mammoth.convertToHtml(
    { buffer: raw },
    {
      convertImage: mammoth.images.imgElement(async (img) => ({
        src: 'scour:image',
        alt: (img as unknown as { altText?: string }).altText || 'image',
      })),
    },
  );
  const ex = extractFromHtml(`<html><body><main>${html}</main></body></html>`, 'https://local.docx/', { full: true, collectLinks: false });
  const text = ex.text.replace(/!\[([^\]]*)\]\((?:scour:image)?\s*\)/g, (_m, alt: string) => `[image: ${alt || 'image'}]`);
  const firstHeading = /^#\s+(.+)$/m.exec(text)?.[1];
  return { title: firstHeading, text, format: 'docx' };
}

/** PDF dates look like D:20240115093000+01'00'. */
function pdfDate(v?: string): string | undefined {
  const m = v && /D:(\d{4})(\d{2})?(\d{2})?/.exec(v);
  if (!m) return undefined;
  return new Date(`${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}T00:00:00Z`).toISOString();
}

// ------------------------------------------------------------------ zip-based formats

async function unzip(raw: Buffer): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  try {
    return unzipSync(new Uint8Array(raw));
  } catch {
    throw new Error('not a valid Office/EPUB file (could not unzip it)');
  }
}

const utf8 = (b: Uint8Array | undefined) => (b ? new TextDecoder('utf-8').decode(b) : '');

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Text runs of a DrawingML paragraph or cell: <a:t>…</a:t>, with <a:br/> as a line break. */
function runs(xml: string): string {
  return xmlText(
    (xml.match(/<a:t>[\s\S]*?<\/a:t>|<a:t\/>|<a:br\/>/g) ?? [])
      .map((t) => (t === '<a:br/>' ? '\n' : t.replace(/<\/?a:t\/?>/g, '')))
      .join(''),
  );
}

function mdTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  if (!rows.length || width === 0) return '';
  const cell = (v: string | undefined) => (v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim();
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i]));
  const [head, ...body] = rows;
  return [`| ${pad(head!).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

/** Relationship id → target path, from a .rels file, resolved against `base`. */
function rels(xml: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) out.set(id, target.startsWith('/') ? target.slice(1) : joinPath(base, target));
  }
  return out;
}

function joinPath(base: string, rel: string): string {
  const parts = base.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function pptxToMarkdown(raw: Buffer): Promise<ConvertedDocument> {
  const files = await unzip(raw);
  const slides = Object.keys(files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(utf8(files['docProps/core.xml']))?.[1];
  const author = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(utf8(files['docProps/core.xml']))?.[1];
  const out: string[] = [];
  for (const [i, path] of slides.entries()) {
    const xml = utf8(files[path]);
    const slideRels = rels(utf8(files[path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')]), 'ppt/slides');
    const parts: string[] = [];
    let heading: string | undefined;
    // Shapes, tables and pictures, in the order they sit on the slide.
    for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>|<p:pic>[\s\S]*?<\/p:pic>/g)) {
      const el = m[0];
      if (el.startsWith('<p:pic>')) {
        const alt = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/.exec(el)?.[1];
        parts.push(`[image${alt ? `: ${xmlText(alt)}` : ''}]`);
      } else if (el.startsWith('<p:graphicFrame>')) {
        const chartId = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(el)?.[1];
        const chartPath = chartId ? slideRels.get(chartId) : undefined;
        if (chartPath && files[chartPath]) {
          parts.push(chartToMarkdown(utf8(files[chartPath])));
          continue;
        }
        const rows = [...el.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((r) => [...r[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) => runs(c[0])));
        if (rows.length) parts.push(mdTable(rows));
      } else {
        const paras = [...el.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g)].map((p) => {
          const text = runs(p[0]).trim();
          const level = Number(/<a:pPr\b[^>]*\blvl="(\d)"/.exec(p[0])?.[1] ?? 0);
          const bullet = /<a:buChar\b|<a:buAutoNum\b/.test(p[0]);
          return text ? `${bullet ? `${'  '.repeat(level)}- ` : ''}${text}` : '';
        }).filter(Boolean);
        if (!paras.length) continue;
        if (!heading && /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(el)) heading = paras.join(' ');
        else parts.push(paras.join('\n'));
      }
    }
    // Speaker notes, linked from the slide's relationships.
    const notesPath = [...slideRels.values()].find((t) => /notesSlide\d+\.xml$/.test(t));
    const notes = notesPath
      ? [...utf8(files[notesPath]).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
          .filter((m) => /<p:ph\b[^>]*type="body"/.test(m[0]))
          .map((m) => [...m[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) => runs(p[0]).trim()).filter(Boolean).join('\n'))
          .join('\n')
      : '';
    out.push(
      [`## Slide ${i + 1}${heading ? `: ${heading}` : ''}`, ...parts, ...(notes ? [`> **Notes:** ${notes.replace(/\n/g, '\n> ')}`] : [])].join('\n\n'),
    );
  }
  if (!slides.length) throw new Error('no slides found in this PowerPoint file');
  return { title: title ? xmlText(title) : undefined, author: author ? xmlText(author) : undefined, text: tidy(out.join('\n\n')), pages: slides.length, format: 'pptx' };
}

/** A chart's title and the numbers behind it, as a table (category × series). */
function chartToMarkdown(xml: string): string {
  const title = runs(/<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0] ?? '').trim();
  const points = (block: string | undefined) => {
    const out: string[] = [];
    for (const m of (block ?? '').matchAll(/<c:pt idx="(\d+)">\s*<c:v>([\s\S]*?)<\/c:v>/g)) out[Number(m[1])] = xmlText(m[2]!);
    return out;
  };
  const series = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((m, i) => ({
    name: xmlText(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(m[0])?.[1] ?? `Series ${i + 1}`),
    cats: points(/<c:cat>[\s\S]*?<\/c:cat>/.exec(m[0])?.[0]),
    vals: points(/<c:val>[\s\S]*?<\/c:val>/.exec(m[0])?.[0] ?? /<c:yVal>[\s\S]*?<\/c:yVal>/.exec(m[0])?.[0]),
  }));
  const cats = series.find((x) => x.cats.length)?.cats ?? [];
  const n = Math.max(cats.length, ...series.map((x) => x.vals.length));
  const rows = [['Category', ...series.map((x) => x.name)], ...Array.from({ length: n }, (_, i) => [cats[i] ?? String(i + 1), ...series.map((x) => x.vals[i] ?? '')])];
  return [`### Chart${title ? `: ${title}` : ''}`, series.length ? mdTable(rows) : ''].filter(Boolean).join('\n\n');
}

async function xlsxToMarkdown(raw: Buffer, maxRows = 500): Promise<ConvertedDocument> {
  const files = await unzip(raw);
  const shared = [...utf8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText((m[1]!.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<\/?t\b[^>]*>/g, '')).join('')),
  );
  const book = utf8(files['xl/workbook.xml']);
  const bookRels = rels(utf8(files['xl/_rels/workbook.xml.rels']), 'xl');
  const sheets = [...book.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => ({
    name: xmlText(/name="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet'),
    path: bookRels.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '',
  }));
  const col = (ref: string) => [.../^[A-Z]+/.exec(ref)?.[0] ?? 'A'].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const out: string[] = [];
  for (const sh of sheets) {
    const xml = utf8(files[sh.path]);
    const rows: string[][] = [];
    let more = 0;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) {
        more++;
        continue;
      }
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const inner = c[2] ?? '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = xmlText((inner.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<\/?t\b[^>]*>/g, '')).join(''));
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = xmlText(v);
        cells[ref ? col(ref) : cells.length] = value;
      }
      if (cells.some((x) => x !== undefined && x !== '')) rows.push(Array.from(cells, (x) => x ?? ''));
    }
    if (!rows.length) continue;
    out.push(`## ${sh.name}\n\n${mdTable(rows)}${more ? `\n\n…[${more} more rows not shown]` : ''}`);
  }
  if (!sheets.length) throw new Error('no sheets found in this Excel file');
  return { text: out.join('\n\n') || '(the workbook is empty)', pages: sheets.length, format: 'xlsx' };
}

async function epubToMarkdown(raw: Buffer): Promise<ConvertedDocument> {
  const files = await unzip(raw);
  const opfPath = /full-path="([^"]+)"/.exec(utf8(files['META-INF/container.xml']))?.[1];
  if (!opfPath || !files[opfPath]) throw new Error('not a valid EPUB (no package file)');
  const opf = utf8(files[opfPath]);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest.set(id, joinPath(base, decodeURIComponent(href)));
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1]!)).filter((p): p is string => !!p && !!files[p]);
  const chapters: string[] = [];
  for (const path of spine) {
    const ex = extractFromHtml(utf8(files[path]), `https://local.epub/${path}`, { full: true, collectLinks: false });
    const text = ex.text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
    if (text) chapters.push(text);
  }
  const meta = (tag: string) => {
    const v = new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)<\/dc:${tag}>`).exec(opf)?.[1];
    return v ? xmlText(v).trim() : undefined;
  };
  return { title: meta('title'), author: meta('creator'), publishedAt: meta('date'), text: tidy(chapters.join('\n\n---\n\n')), pages: spine.length, format: 'epub' };
}

/** CSV/TSV with quoted fields and embedded newlines, as a Markdown table. */
function delimitedToMarkdown(text: string, format: 'csv' | 'tsv', maxRows = 1000): ConvertedDocument {
  const rows = parseDelimited(text.replace(/^\uFEFF/, ''), format === 'tsv' ? '\t' : ',');
  const shown = rows.slice(0, maxRows + 1);
  const more = rows.length - shown.length;
  return {
    text: `${mdTable(shown)}${more > 0 ? `\n\n…[${more} more rows not shown]` : ''}`,
    pages: 1,
    format,
  };
}

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}
