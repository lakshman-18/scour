import { extractFromHtml, tidy } from './extract.js';

/**
 * Binary documents → Markdown, locally and free. PDF via pdf.js (unpdf),
 * Word via mammoth. No upload to any service.
 */
export interface ConvertedDocument {
  title?: string;
  author?: string;
  text: string;
  pages?: number;
  publishedAt?: string;
  format: 'pdf' | 'docx';
}

export function documentFormat(contentType: string, url: string): 'pdf' | 'docx' | null {
  if (/application\/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url)) return 'pdf';
  if (/officedocument\.wordprocessingml/i.test(contentType) || /\.docx($|\?)/i.test(url)) return 'docx';
  return null;
}

export async function convertDocument(raw: Buffer, format: 'pdf' | 'docx', opts: { maxPages?: number } = {}): Promise<ConvertedDocument> {
  return format === 'pdf' ? pdfToMarkdown(raw, opts.maxPages) : docxToMarkdown(raw);
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
