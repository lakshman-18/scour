import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDoc, prov } from '../adapters/_helpers.js';
import { configHome } from './config.js';
import { convertDocument, documentFormat } from './documents.js';
import { extractFromHtml } from './extract.js';
import { Tier, type Document } from './types.js';

/**
 * Files on this machine → the same Markdown Document as a web page: PDF,
 * Word, PowerPoint, Excel, EPUB, CSV/TSV, HTML, Markdown, text and JSON.
 *
 * Only the CLI and the MCP tools read local files. The HTTP server never
 * does, so a web request can't reach into the machine.
 */
export const READABLE_FILES = /\.(pdf|docx|pptx|xlsx|epub|csv|tsv|html?|md|markdown|txt|json|xml)$/i;
const MAX_BYTES = 100 * 1024 * 1024;

/** A path rather than a URL: written like one (/, ~/, ./, file://), or a file that exists here ("report.pdf"). */
export async function isLocalFile(input: string): Promise<boolean> {
  if (/^(\/|~\/|\.{1,2}\/|file:\/\/)/.test(input)) return true;
  if (/^https?:\/\//i.test(input)) return false;
  return (await fs.stat(input).catch(() => null))?.isFile() ?? false;
}

export function resolvePath(input: string): string {
  const p = input.startsWith('file://') ? decodeURIComponent(new URL(input).pathname) : input;
  return path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
}

/**
 * Read a local file. With `restrict` (MCP: requests can come from a model
 * reading untrusted pages), only document types are allowed and hidden
 * folders (~/.ssh, ~/.scour…) are refused.
 */
export async function readLocalFile(input: string, opts: { restrict?: boolean } = {}): Promise<Document> {
  const file = resolvePath(input);
  const st = await fs.stat(file).catch(() => null);
  if (!st) throw new Error(`No such file: ${file}`);
  if (!st.isFile()) throw new Error(`Not a file: ${file}`);
  if (st.size > MAX_BYTES) throw new Error(`${path.basename(file)} is ${(st.size / 1048576).toFixed(0)} MB; the limit is 100 MB`);
  if (opts.restrict) {
    if (!READABLE_FILES.test(file)) throw new Error(`Only documents can be read this way (PDF, Word, PowerPoint, Excel, EPUB, CSV, HTML, Markdown, text, JSON): ${path.basename(file)}`);
    if (file.split(path.sep).some((seg) => seg.startsWith('.') && seg.length > 1) || file.startsWith(configHome())) {
      throw new Error('Files in hidden folders are not read this way.');
    }
  }

  const raw = await fs.readFile(file);
  const url = pathToFileURL(file).href;
  const name = path.basename(file);
  const base = { url, source: 'file', kind: 'file' as const, publishedAt: st.mtime.toISOString() };
  const provenance = (strategy: string) => prov({ tier: Tier.Native, adapter: 'file', strategy, finalUrl: url, bytes: raw.length });

  const format = documentFormat('', file);
  if (format) {
    const conv = await convertDocument(raw, format);
    if (conv.text.trim().length < 20 && format === 'pdf') {
      throw new Error(`${name} has no extractable text (probably scanned images; OCR is not supported yet).`);
    }
    return makeDoc({
      ...base,
      title: conv.title || name,
      text: conv.text,
      author: conv.author ? { name: conv.author } : undefined,
      publishedAt: conv.publishedAt ?? base.publishedAt,
      extra: { format, pages: conv.pages, file },
      provenance: provenance(`${format} → markdown`),
    });
  }
  const text = raw.toString('utf-8');
  if (/\.html?$/i.test(file)) {
    const ex = extractFromHtml(text, url, { full: false });
    return makeDoc({ ...base, title: ex.title || name, text: ex.text, extra: { format: 'html', file }, provenance: provenance('html → markdown') });
  }
  const lang = /\.json$/i.test(file) ? 'json' : /\.xml$/i.test(file) ? 'xml' : '';
  return makeDoc({
    ...base,
    title: (/^#\s+(.+)$/m.exec(text)?.[1] ?? name).trim(),
    text: lang ? `\`\`\`${lang}\n${text.trim()}\n\`\`\`` : text,
    extra: { format: lang || path.extname(file).slice(1) || 'text', file },
    provenance: provenance('local file'),
  });
}
