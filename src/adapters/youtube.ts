import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normDate, tidy } from '../core/extract.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type SearchResult,
} from '../core/types.js';
import { human, makeDoc, prov, truncate } from './_helpers.js';

const exec = promisify(execFile);

/**
 * YouTube: metadata + transcript, free.
 *
 * YouTube actively rotates its defences, so this is a ladder of four
 * independent strategies rather than one clever trick. If one dies we lose a
 * rung, not the adapter.
 */
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

export const youtubeAdapter: Adapter = {
  name: 'youtube',
  priority: 50,

  match(url: URL): boolean {
    return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(url.hostname) || url.hostname === 'youtu.be';
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const videoId = extractVideoId(url);
    if (!videoId) {
      if (url.pathname.startsWith('/results')) {
        const q = url.searchParams.get('search_query');
        if (q) return searchAsDocument(q, ctx, url);
      }
      throw new TierError(`No video id in ${url.href}`, Tier.Native, false);
    }

    const wantTranscript = ctx.options.transcript !== false;
    const errors: string[] = [];

    // Strategy 1: oEmbed — tiny, never blocked, gives title + channel.
    const basic = await oembed(videoId, ctx).catch((e) => {
      errors.push(`oembed: ${(e as Error).message}`);
      return null;
    });

    // Strategy 2: Innertube player API — full metadata + caption track list.
    let player = await innertube(videoId, ctx).catch((e) => {
      errors.push(`innertube: ${(e as Error).message}`);
      return null;
    });

    // Strategy 3: watch-page scrape for ytInitialPlayerResponse.
    if (!player) {
      player = await watchPage(videoId, ctx).catch((e) => {
        errors.push(`watch page: ${(e as Error).message}`);
        return null;
      });
    }

    let transcript = '';
    let transcriptSource = 'none';
    if (wantTranscript) {
      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (tracks.length) {
        const track = pickTrack(tracks);
        if (track) {
          transcript = await fetchTranscript(track.baseUrl, ctx).catch((e) => {
            errors.push(`captions: ${(e as Error).message}`);
            return '';
          });
          if (transcript) transcriptSource = `captions (${track.languageCode}${track.kind === 'asr' ? ', auto' : ''})`;
        }
      }
      // Strategy 4: yt-dlp. YouTube now token-gates caption files, and yt-dlp is
      // the community-maintained tool that keeps up with it. We find it on PATH,
      // or run it ephemerally through pipx/uv so the user installs nothing.
      if (!transcript && (await ytDlpCommand())) {
        transcript = await ytDlpTranscript(videoId, ctx).catch((e) => {
          errors.push(`yt-dlp: ${(e as Error).message}`);
          return '';
        });
        if (transcript) transcriptSource = 'yt-dlp';
      }
    }

    const d = player?.videoDetails;
    const title = d?.title ?? basic?.title;
    if (!title && !transcript) {
      throw new TierError(
        `Could not read YouTube video ${videoId}. Tried:\n  ${errors.join('\n  ')}\n` +
          '  Hint: install yt-dlp (or have pipx/uv on PATH) for transcripts.',
        Tier.Native,
      );
    }

    const views = Number(d?.viewCount ?? 0) || undefined;
    const lengthSec = Number(d?.lengthSeconds ?? 0) || undefined;
    const body = [
      `# ${title ?? videoId}`,
      '',
      `**${d?.author ?? basic?.author_name ?? 'unknown channel'}**` +
        (views ? ` · ${human(views)} views` : '') +
        (lengthSec ? ` · ${fmtDuration(lengthSec)}` : ''),
      '',
      d?.shortDescription ? `## Description\n\n${d.shortDescription.trim()}\n` : '',
      transcript ? `## Transcript\n\n${transcript}` : '_No transcript available for this video._',
    ];

    return makeDoc({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      source: 'youtube',
      nativeId: videoId,
      kind: 'video',
      title: title ?? videoId,
      text: tidy(body.join('\n')),
      excerpt: truncate(d?.shortDescription?.replace(/\s+/g, ' '), 280) || undefined,
      author: {
        name: d?.author ?? basic?.author_name,
        url: basic?.author_url ?? (d?.channelId ? `https://www.youtube.com/channel/${d.channelId}` : undefined),
      },
      publishedAt: normDate(player?.microformat?.playerMicroformatRenderer?.publishDate),
      engagement: { views },
      media: [{
        type: 'video',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        durationSec: lengthSec,
        transcript: transcript || undefined,
      }],
      tags: d?.keywords?.slice(0, 20) ?? [],
      extra: {
        videoId, channelId: d?.channelId, transcriptSource,
        transcriptChars: transcript.length,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        warnings: errors.length ? errors : undefined,
      },
      provenance: prov({
        tier: transcriptSource === 'yt-dlp' ? Tier.Headless : Tier.Native,
        adapter: 'youtube',
        strategy: `${player ? 'player api' : 'oembed'} + ${transcriptSource}`,
        finalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        httpStatus: 200,
      }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const res = await ctx.http.post(
      `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`,
      { context: webContext(), query },
      { timeoutMs: ctx.options.timeoutMs, headers: { 'Content-Type': 'application/json' } },
    );
    const json = JSON.parse(res.body) as Record<string, any>;
    const sections =
      json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
    const out: SearchResult[] = [];
    for (const sec of sections) {
      for (const item of sec?.itemSectionRenderer?.contents ?? []) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;
        const views = Number(String(v.viewCountText?.simpleText ?? '').replace(/[^\d]/g, '')) || undefined;
        out.push({
          title: text(v.title) || v.videoId,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          snippet: (v.detailedMetadataSnippets?.[0]?.snippetText?.runs ?? []).map((r: any) => r.text).join('') || undefined,
          source: 'youtube',
          author: { name: text(v.ownerText) || text(v.longBylineText) },
          engagement: { views },
          extra: {
            videoId: v.videoId,
            duration: v.lengthText?.simpleText,
            published: v.publishedTimeText?.simpleText,
          },
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  async health(): Promise<HealthReport> {
    const cmd = await ytDlpCommand();
    return {
      adapter: 'youtube',
      status: cmd ? 'ready' : 'degraded',
      detail: cmd
        ? `Metadata, search and transcripts (transcripts via \`${cmd.join(' ')}\`).`
        : 'Metadata and search work. Transcripts need yt-dlp: YouTube now token-gates caption files.',
      fix: cmd ? undefined : 'Install one of: `brew install yt-dlp`, `pipx install yt-dlp`, or just have pipx/uv on PATH (scour runs it ephemerally).',
      capabilities: ['video metadata', 'search', ...(cmd ? ['transcript'] : [])],
    };
  },
};

interface PlayerResponse {
  videoDetails?: {
    videoId: string; title: string; shortDescription: string; lengthSeconds: string;
    viewCount: string; author: string; channelId: string; keywords?: string[];
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } }[];
    };
  };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string } };
  playabilityStatus?: { status?: string; reason?: string };
}

function webContext() {
  return {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20240726.00.00',
      hl: 'en',
      gl: 'US',
    },
  };
}

async function innertube(videoId: string, ctx: AdapterContext): Promise<PlayerResponse> {
  // Several clients, because YouTube gates them differently over time.
  const clients = [
    { clientName: 'WEB', clientVersion: '2.20240726.00.00' },
    { clientName: 'MWEB', clientVersion: '2.20240726.01.00' },
    { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
  ];
  let last = '';
  for (const client of clients) {
    try {
      const res = await ctx.http.post(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { context: { client: { ...client, hl: 'en', gl: 'US' } }, videoId, contentCheckOk: true, racyCheckOk: true },
        {
          timeoutMs: ctx.options.timeoutMs,
          retries: 0,
          headers: { 'Content-Type': 'application/json', Origin: 'https://www.youtube.com' },
        },
      );
      const json = JSON.parse(res.body) as PlayerResponse;
      const status = json.playabilityStatus?.status;
      if (json.videoDetails || json.captions) return json;
      last = `${client.clientName}: ${status ?? 'no videoDetails'} ${json.playabilityStatus?.reason ?? ''}`.trim();
    } catch (err) {
      last = `${client.clientName}: ${(err as Error).message}`;
    }
  }
  throw new Error(last || 'all innertube clients failed');
}

async function watchPage(videoId: string, ctx: AdapterContext): Promise<PlayerResponse> {
  const res = await ctx.http.get(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    timeoutMs: ctx.options.timeoutMs,
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const json = sliceJson(res.body, 'ytInitialPlayerResponse');
  if (!json) throw new Error('ytInitialPlayerResponse not present in watch page');
  return JSON.parse(json) as PlayerResponse;
}

/** Pull a balanced JSON object out of an inline `var X = {...};` assignment. */
function sliceJson(html: string, varName: string): string | null {
  const start = html.indexOf(varName);
  if (start === -1) return null;
  const brace = html.indexOf('{', start);
  if (brace === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = brace; i < html.length; i++) {
    const c = html[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(brace, i + 1);
  }
  return null;
}

function pickTrack(tracks: { baseUrl: string; languageCode: string; kind?: string }[]) {
  // Prefer a human English track, then any human track, then auto-generated.
  return (
    tracks.find((t) => t.languageCode.startsWith('en') && t.kind !== 'asr') ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode.startsWith('en')) ??
    tracks[0]
  );
}

async function fetchTranscript(baseUrl: string, ctx: AdapterContext): Promise<string> {
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
  const res = await ctx.http.get(url, { timeoutMs: ctx.options.timeoutMs });
  // A 200 with an empty body means YouTube now wants a proof-of-origin token.
  if (!res.body.trim()) throw new Error('caption URL returned empty (token-gated)');
  return parseCaptionBody(res.body);
}

/** Wrap a wall of caption text into readable ~90-char lines. */
function collapse(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + w).length > 90) {
      lines.push(cur.trim());
      cur = '';
    }
    cur += `${w} `;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n');
}

/** json3 or XML caption payload → readable text. */
function parseCaptionBody(body: string): string {
  try {
    const json = JSON.parse(body) as { events?: { segs?: { utf8: string }[] }[] };
    return collapse(
      (json.events ?? [])
        .map((e) => (e.segs ?? []).map((s) => s.utf8).join('').replace(/\n/g, ' ').trim())
        .filter(Boolean)
        .join(' '),
    );
  } catch {
    return collapse(
      body.replace(/<[^>]+>/g, ' ').replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;quot;|&quot;/g, '"').replace(/&amp;/g, '&'),
    );
  }
}

let ytDlpResolved: string[] | null | undefined;

/** Resolve how to invoke yt-dlp: installed binary, else pipx/uv ephemeral run. */
async function ytDlpCommand(): Promise<string[] | null> {
  if (ytDlpResolved !== undefined) return ytDlpResolved;
  const candidates: string[][] = [['yt-dlp'], ['pipx', 'run', 'yt-dlp'], ['uvx', 'yt-dlp']];
  for (const cmd of candidates) {
    try {
      // First pipx/uv run downloads yt-dlp into a cache; allow time for that once.
      await exec(cmd[0]!, [...cmd.slice(1), '--version'], { timeout: 90_000 });
      ytDlpResolved = cmd;
      return cmd;
    } catch {
      // try next
    }
  }
  ytDlpResolved = null;
  return null;
}


async function ytDlpTranscript(videoId: string, ctx: AdapterContext): Promise<string> {
  const cmd = await ytDlpCommand();
  if (!cmd) throw new Error('yt-dlp not available');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scour-yt-'));
  try {
    await exec(
      cmd[0]!,
      [
        ...cmd.slice(1),
        '--skip-download', '--write-auto-subs', '--write-subs',
        '--sub-langs', 'en.*,en', '--sub-format', 'vtt', '--no-warnings', '--quiet',
        '-o', path.join(dir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: Math.max(ctx.options.timeoutMs, 60_000) },
    );
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.vtt')).sort((a, b) => a.length - b.length);
    if (!files.length) throw new Error('yt-dlp produced no subtitle file');
    return vttToText(await fs.readFile(path.join(dir, files[0]!), 'utf-8'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** WebVTT → plain text, dropping cue timings and the duplicate rolling lines. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  let prev = '';
  for (const raw of vtt.split('\n')) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (line.includes('-->') || /^\d+$/.test(line)) continue;
    const clean = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!clean || clean === prev) continue;
    out.push(clean);
    prev = clean;
  }
  return collapse(out.join(' '));
}

async function oembed(videoId: string, ctx: AdapterContext): Promise<{ title: string; author_name: string; author_url: string }> {
  return ctx.http.json(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    { timeoutMs: ctx.options.timeoutMs, retries: 1 },
  );
}

async function searchAsDocument(query: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const hits = await youtubeAdapter.search!(query, ctx, 20);
  const lines = hits.map((h, i) => `${i + 1}. **[${h.title}](${h.url})**\n   ${h.author?.name ?? ''} · ${h.extra?.duration ?? ''} · ${h.extra?.published ?? ''}`);
  return makeDoc({
    url: url.href, source: 'youtube', kind: 'listing', title: `YouTube search: ${query}`,
    text: [`# YouTube search: ${query}`, '', ...lines].join('\n'),
    provenance: prov({ tier: Tier.Native, adapter: 'youtube', strategy: 'innertube search', finalUrl: url.href }),
  });
}

export function extractVideoId(url: URL): string | null {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  const v = url.searchParams.get('v');
  if (v) return v;
  const m = /\/(embed|shorts|live|v)\/([\w-]{6,})/.exec(url.pathname);
  return m?.[2] ?? null;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function text(node: any): string {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r.text).join('');
  return '';
}
