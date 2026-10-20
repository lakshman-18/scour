import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeDoc, prov } from '../adapters/_helpers.js';
import { Tier, type Document } from '../core/types.js';
import { renderUnderstanding, understandVideo } from './understand.js';

/** A video (file or link) as a scour Document: the walkthrough as text, key frames as images. */
export async function videoDocument(
  source: string,
  opts: { images?: number; lang?: string; ocr?: boolean; narration?: boolean; onProgress?: (m: string) => void } = {},
): Promise<Document> {
  const v = await understandVideo(source, opts);
  const r = renderUnderstanding(v, opts.images ?? 8);
  const url = /^https?:/i.test(source) ? source : pathToFileURL(source).href;
  return makeDoc({
    url,
    source: /^https?:/i.test(source) ? 'video' : 'file',
    kind: 'video',
    title: path.basename(source.replace(/[?#].*$/, '')),
    text: r.markdown,
    media: [
      { type: 'video', url, durationSec: v.duration },
      ...r.images.map((i) => ({ type: 'image' as const, url: `data:${i.mimeType};base64,${i.data}`, alt: i.label })),
    ],
    extra: {
      screens: v.screens.map((s) => ({ id: s.id, sameAs: s.sameAs, start: s.start, end: s.end, title: s.title, controls: s.controls, via: s.via, said: s.said || undefined })),
      ocr: v.ocr,
      narration: v.narration || undefined,
    },
    provenance: prov({ tier: Tier.Native, adapter: 'video', strategy: `screens + ${v.ocr} OCR${v.narration ? ` + ${v.narration}` : ''}`, finalUrl: url }),
  });
}
