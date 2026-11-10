import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeDoc, prov } from '../adapters/_helpers.js';
import { Tier, type Document } from '../core/types.js';
import { renderWatched } from './report.js';
import { describe, watchVideo } from './watch.js';

/** A video (file or link) as a scour Document: what was done, step by step, with evidence pictures. */
export async function videoDocument(
  source: string,
  opts: { images?: number; lang?: string; ocr?: boolean; narration?: boolean; onProgress?: (m: string) => void } = {},
): Promise<Document> {
  const w = await watchVideo(source, opts);
  try {
    const r = await renderWatched(w, opts.images ?? 8);
    const url = /^https?:/i.test(source) ? source : pathToFileURL(source).href;
    return makeDoc({
      url,
      source: /^https?:/i.test(source) ? 'video' : 'file',
      kind: 'video',
      title: path.basename(source.replace(/[?#].*$/, '')),
      text: r.markdown,
      media: [
        { type: 'video', url, durationSec: w.duration },
        ...r.images.map((i) => ({ type: 'image' as const, url: `data:${i.mimeType};base64,${i.data}`, alt: i.label })),
      ],
      extra: {
        screens: w.screens.map((s) => ({ id: s.id, title: s.title, firstSeen: s.firstSeen, visits: s.visits, elements: s.els.map((e) => ({ kind: e.kind, text: e.text })) })),
        steps: w.actions.map((a) => ({ n: a.n, t: +a.t.toFixed(2), kind: a.kind, evidence: a.evidence, target: a.target && { kind: a.target.kind, text: a.target.text }, pointer: a.pointer, typed: a.typed, result: a.result, responseSec: a.responseSec, loadingSec: a.loadingSec, said: a.said, text: describe(a) })),
        ocr: w.ocr,
        narration: w.narrationEngine,
        pointerSeen: w.pointerSeen,
      },
      provenance: prov({ tier: Tier.Native, adapter: 'video', strategy: `watched: pointer by shape + ${w.ocr} OCR${w.narrationEngine ? ` + ${w.narrationEngine}` : ''}`, finalUrl: url }),
    });
  } finally {
    await w.cleanup();
  }
}
