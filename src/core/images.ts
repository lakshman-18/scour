import type { Document } from './types.js';

export interface FetchedImage {
  url: string;
  mimeType: string;
  /** base64 */
  data: string;
  bytes: number;
}

const SUPPORTED = /^image\/(jpeg|png|gif|webp)$/;
// Avatars, emoji and UI chrome: never the content an agent wants to see.
const SKIP = /\/profile_images\/|\/emoji\/|\/hashflags\/|favicon|sprite|logo\.(svg|png)|\/avatar|\/icons?\//i;

/**
 * Ask image CDNs for a sensible size: big enough to read text in a screenshot,
 * small enough not to waste the agent's context. X's media CDN takes a size name.
 */
export function viewableUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
      const id = u.pathname.replace(/^\/media\//, '').replace(/\.(jpe?g|png|webp)$/i, '');
      return `https://pbs.twimg.com/media/${id}?format=jpg&name=medium`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Download a document's images so a vision-capable model can look at them.
 * scour does no image understanding itself — the calling model does — so this
 * stays free and needs no extra API.
 */
export async function fetchImages(
  doc: Document,
  opts: { max?: number; maxBytes?: number; timeoutMs?: number; userAgent?: string } = {},
): Promise<{ images: FetchedImage[]; skipped: { url: string; reason: string }[] }> {
  const max = opts.max ?? 6;
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const m of doc.media ?? []) {
    if (m.type !== 'image' || SKIP.test(m.url)) continue;
    const u = viewableUrl(m.url);
    if (seen.has(u)) continue;
    seen.add(u);
    candidates.push(u);
  }

  const images: FetchedImage[] = [];
  const skipped: { url: string; reason: string }[] = [];
  for (const url of candidates) {
    if (images.length >= max) {
      skipped.push({ url, reason: `over the ${max}-image limit` });
      continue;
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 scour', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!SUPPORTED.test(mimeType)) throw new Error(`unsupported type ${mimeType || 'unknown'}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new Error(`too large (${declared} bytes)`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`too large (${buf.length} bytes)`);
      if (buf.length < 2048) throw new Error('too small to be content (icon or pixel)');
      images.push({ url, mimeType, data: buf.toString('base64'), bytes: buf.length });
    } catch (err) {
      skipped.push({ url, reason: (err as Error).message });
    }
  }
  return { images, skipped };
}
