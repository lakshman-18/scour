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
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';
import {
  RateLimited, downloadAudio, ffmpegAvailable, fmtTime, frameTimes, grabFrames, mostReplayed, parseJson3, pickCaptions,
  renderTranscript, seekableStream, sponsorSegments, transcribeFile, translateLines, videoInfo, withoutSegments, ytDlpCommand,
  type Frame, type Segment, type SkipSegment, type VideoInfo,
} from './video.js';

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

    const ao = (ctx.options.adapterOptions ?? {}) as { lang?: string; frames?: number; transcribe?: boolean; keepSponsors?: boolean; timeline?: boolean };
    const wantTranscript = ctx.options.transcript !== false;
    const c = ctx.options.comments;
    const wantComments = c === false || c === 0 ? 0 : typeof c === 'number' ? Math.min(c, 100) : c === true ? 20 : 0;
    const wantFrames = Math.min(Math.max(Number(ao.frames ?? 0), 0), 20);
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const errors: string[] = [];

    // Strategy 1: oEmbed — tiny, never blocked, gives title + channel.
    const basic = await oembed(videoId, ctx).catch((e) => {
      errors.push(`oembed: ${(e as Error).message}`);
      return null;
    });

    // Strategy 2: Innertube player API — metadata, sometimes caption tracks.
    let player = await innertube(videoId, ctx).catch((e) => {
      errors.push(`innertube: ${(e as Error).message}`);
      return null;
    });
    if (!player) {
      player = await watchPage(videoId, ctx).catch((e) => {
        errors.push(`watch page: ${(e as Error).message}`);
        return null;
      });
    }

    // Strategy 3: yt-dlp, once: chapters, heatmap, likes, caption tracks in
    // every language, top comments, stream URLs for frames. YouTube token-gates
    // caption files, and yt-dlp is the community tool that keeps up with it.
    let info: VideoInfo | null = null;
    if (wantTranscript || wantComments || wantFrames) {
      const cooling = await ctx.cache.get<string>(YT_COOLDOWN_KEY);
      if (cooling) {
        errors.push(`yt-dlp: skipped; YouTube rate-limited this connection at ${cooling.value}. Transcripts resume after a short cool-down.`);
      } else if (await ytDlpCommand()) {
        info = await videoInfo(watchUrl, { comments: wantComments, timeoutMs: ctx.options.timeoutMs }).catch(async (e) => {
          if (e instanceof RateLimited) {
            await ctx.cache.set(YT_COOLDOWN_KEY, new Date().toISOString().slice(11, 16) + ' UTC', YT_COOLDOWN_SEC);
            errors.push(`yt-dlp: ${e.message} scour will pause YouTube requests for 45 minutes.`);
          } else errors.push(`yt-dlp: ${(e as Error).message}`);
          return null;
        });
      }
    }

    // Transcript: captions (any language, or YouTube's auto-translation), else local Whisper.
    let segments: Segment[] = [];
    let transcriptSource = 'none';
    let transcriptNote = '';
    if (wantTranscript) {
      // A requested language first; YouTube translates on the fly but often
      // refuses (429), so then the original language, said plainly.
      const tries = info ? [pickCaptions(info, ao.lang), ...(ao.lang ? [pickCaptions(info)] : [])].filter((x): x is NonNullable<typeof x> => !!x) : [];
      for (const cap of tries) {
        try {
          const res = await ctx.http.get(cap.url, { timeoutMs: Math.min(ctx.options.timeoutMs, 25_000), retries: 0, allowStatus: [429] });
          if (res.status === 429 || !res.body.trim().startsWith('{')) throw new Error(cap.kind === 'translated' ? "YouTube's translation service is rate-limiting this connection" : 'YouTube refused the caption file (HTTP 429)');
          segments = parseJson3(res.body);
          transcriptSource = `${cap.kind === 'human' ? 'captions' : cap.kind === 'auto' ? 'auto captions' : 'YouTube auto-translation'} (${cap.lang})`;
          if (ao.lang && !cap.lang.startsWith(ao.lang)) transcriptNote = `Asked for "${ao.lang}" but ${errors.at(-1)?.replace(/^captions: /, '') ?? 'it was not available'}; this is the original ${cap.lang} transcript. Any AI can translate it.`;
          break;
        } catch (e) {
          errors.push(`captions: ${(e as Error).message}`);
        }
      }
      if (info && ao.lang && !tries.length) errors.push(`captions: no ${ao.lang} track and YouTube offers no translation into it`);
      if (!segments.length && !info) {
        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        const track = tracks.length ? pickTrack(tracks) : undefined;
        if (track) {
          segments = await fetchSegments(track.baseUrl, ctx).catch((e) => {
            errors.push(`captions: ${(e as Error).message}`);
            return [];
          });
          if (segments.length) transcriptSource = `captions (${track.languageCode}${track.kind === 'asr' ? ', auto' : ''})`;
        }
      }
      // YouTube would not translate: translate on this machine instead.
      if (segments.length && ao.lang && transcriptNote) {
        const from = (/\((\w+)/.exec(transcriptSource)?.[1] ?? 'en').split('-')[0]!;
        try {
          const lines = await translateLines(segments.map((x) => x.text), from, ao.lang);
          segments = segments.map((x, i) => ({ ...x, text: lines[i] ?? x.text }));
          transcriptSource = `${transcriptSource.replace(/\)$/, '')} → ${ao.lang}, translated on this machine with Argos Translate)`;
          transcriptNote = `YouTube's own translation was unavailable, so this was translated offline (good, not perfect).`;
        } catch (e) {
          errors.push(`local translation: ${(e as Error).message}`);
        }
      }
      if (!segments.length && ao.transcribe) {
        try {
          const audio = await downloadAudio(watchUrl, ctx.options.timeoutMs);
          try {
            const vocab = [info?.title, info?.channel, ...(info?.chapters ?? []).map((ch) => ch.title)].filter(Boolean).join(', ');
            const t = await transcribeFile(audio.file, { lang: ao.lang, allowEphemeral: true, prompt: vocab });
            segments = t.segments;
            transcriptSource = `${t.engine}, on this machine`;
          } finally {
            await audio.cleanup();
          }
        } catch (e) {
          errors.push(`whisper: ${(e as Error).message}`);
        }
      }
    }

    // Sponsor reads and "smash that like button" cut out (SponsorBlock).
    let skipped: SkipSegment[] = [];
    if (segments.length && !ao.keepSponsors) {
      skipped = await sponsorSegments(videoId, ctx.http).catch(() => []);
      segments = withoutSegments(segments, skipped);
    }

    // Frames, so a model can see what is on screen.
    let frames: Frame[] = [];
    if (wantFrames) {
      const stream = info ? seekableStream(info) : undefined;
      if (!(await ffmpegAvailable())) errors.push('frames: ffmpeg is not installed (brew install ffmpeg)');
      else if (!stream) errors.push('frames: no seekable video stream (yt-dlp unavailable or rate-limited)');
      else {
        const times = frameTimes(info!.duration ?? 0, info!.chapters, mostReplayed(info!.heatmap), wantFrames);
        frames = await grabFrames(stream, times, wantFrames).catch((e) => {
          errors.push(`frames: ${(e as Error).message}`);
          return [];
        });
      }
    }

    const d = player?.videoDetails;
    const title = info?.title ?? d?.title ?? basic?.title;
    if (!title && !segments.length) {
      throw new TierError(
        `Could not read YouTube video ${videoId}. Tried:\n  ${errors.join('\n  ')}\n` +
          '  Hint: install yt-dlp (or have pipx/uv on PATH) for transcripts.',
        Tier.Native,
      );
    }

    const views = info?.views ?? (Number(d?.viewCount ?? 0) || undefined);
    const lengthSec = info?.duration ?? (Number(d?.lengthSeconds ?? 0) || undefined);
    const channel = info?.channel ?? d?.author ?? basic?.author_name ?? 'unknown channel';
    const at = (sec: number) => `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(sec)}s`;
    const chapters = info?.chapters ?? [];
    const peaks = info ? mostReplayed(info.heatmap) : [];
    const chapterAt = (sec: number) => chapters.find((ch) => sec >= ch.start && sec < ch.end)?.title;
    const comments = info ? commentTree(info.comments, videoId) : [];

    const stats = [
      `**${channel}**${info?.followers ? ` (${human(info.followers)} subscribers)` : ''}`,
      views ? `${human(views)} views` : '',
      info?.likes ? `${human(info.likes)} likes` : '',
      info?.commentCount ? `${human(info.commentCount)} comments` : '',
      lengthSec ? fmtDuration(lengthSec) : '',
      info?.uploadDate ?? '',
    ].filter(Boolean).join(' · ');
    const body = [
      `# ${title ?? videoId}`,
      '',
      stats,
      '',
      chapters.length ? `## Chapters\n\n${chapters.map((ch) => `- [${fmtTime(ch.start)}](${at(ch.start)}) ${ch.title}`).join('\n')}\n` : '',
      peaks.length
        ? `## Most replayed\n\n${peaks.map((p) => `- [${fmtTime(p.start)}–${fmtTime(p.end)}](${at(p.start)})${chapterAt(p.start) ? ` in "${chapterAt(p.start)}"` : ''}`).join('\n')}\n`
        : '',
      (info?.description ?? d?.shortDescription) ? `## Description\n\n${(info?.description ?? d!.shortDescription!).trim()}\n` : '',
      segments.length
        ? `## Transcript (${transcriptSource})\n\n${transcriptNote ? `_${transcriptNote}_\n\n` : ''}${skipped.length ? `_Left out ${skipped.length} sponsor/self-promotion ${skipped.length === 1 ? 'segment' : 'segments'} (${skipped.map((k) => `${fmtTime(k.start)}–${fmtTime(k.end)}`).join(', ')}), marked by SponsorBlock._\n\n` : ''}${renderTranscript(segments, chapters, at)}`
        : `_No transcript available for this video.${!ao.transcribe && info ? ' It has no captions; run again with --transcribe to transcribe it on this machine (free, local Whisper).' : ''}_`,
      frames.length
        ? `\n## Frames\n\n${frames.map((f, i) => `${i + 1}. [${fmtTime(f.at)}](${at(f.at)})${f.label ? ` ${f.label}` : chapterAt(f.at) ? ` ${chapterAt(f.at)}` : ''}`).join('\n')}\n\n_The frame images are attached (MCP) or saved with --save-images._`
        : '',
      comments.length ? `\n## Top comments\n\n${renderThread(comments)}` : '',
    ];
    const plain = segments.map((x) => x.text).join(' ');

    return makeDoc({
      url: watchUrl,
      source: 'youtube',
      nativeId: videoId,
      kind: 'video',
      title: title ?? videoId,
      text: tidy(body.join('\n')),
      excerpt: truncate((info?.description ?? d?.shortDescription)?.replace(/\s+/g, ' '), 280) || undefined,
      author: {
        name: channel,
        url: info?.channelUrl ?? basic?.author_url ?? (d?.channelId ? `https://www.youtube.com/channel/${d.channelId}` : undefined),
        followers: info?.followers,
      },
      publishedAt: normDate(info?.uploadDate ?? player?.microformat?.playerMicroformatRenderer?.publishDate),
      engagement: { views, score: info?.likes, comments: info?.commentCount },
      media: [
        { type: 'video', url: watchUrl, durationSec: lengthSec, transcript: plain || undefined },
        ...frames.map((f) => ({ type: 'image' as const, url: `data:${f.mimeType};base64,${f.data}`, alt: `Frame at ${fmtTime(f.at)}${f.label ? `: ${f.label}` : ''}` })),
      ],
      children: comments.length ? comments : undefined,
      tags: d?.keywords?.slice(0, 20) ?? [],
      extra: {
        videoId, channelId: d?.channelId, transcriptSource,
        transcriptChars: plain.length,
        chapters: chapters.length || undefined,
        sponsorSegmentsRemoved: skipped.length || undefined,
        frames: frames.length ? frames.map((f) => ({ at: f.at, label: f.label })) : undefined,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        warnings: errors.length ? errors : undefined,
        // Raw timed data for the creator tools (scour yt …), only when asked: it is large.
        timeline: ao.timeline
          ? { segments, heatmap: info?.heatmap ?? [], chapters, duration: lengthSec, comments: info?.comments ?? [], channelUrl: info?.channelUrl, followers: info?.followers }
          : undefined,
        // Missing parts because of a refusal or rate limit: worth trying again later, so not cached.
        degraded: (wantTranscript && !segments.length && errors.length > 0) || (wantFrames > 0 && !frames.length) || undefined,
      },
      provenance: prov({
        tier: info ? Tier.Headless : Tier.Native,
        adapter: 'youtube',
        strategy: `${info ? 'yt-dlp' : player ? 'player api' : 'oembed'} + ${transcriptSource}${frames.length ? ` + ${frames.length} frames` : ''}`,
        finalUrl: watchUrl,
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
    const { whisperCommand } = await import('./video.js');
    const [cmd, ffmpeg, whisper] = await Promise.all([ytDlpCommand(), ffmpegAvailable(), whisperCommand(false)]);
    const pipx = !!cmd && cmd[0] !== 'yt-dlp';
    return {
      adapter: 'youtube',
      status: cmd ? 'ready' : 'degraded',
      detail: cmd
        ? `Transcripts by chapter in any caption language, most-replayed moments, top comments, sponsor segments cut (via \`${cmd.join(' ')}\`). ` +
          `Key frames: ${ffmpeg ? 'yes' : 'need ffmpeg'}. Videos without captions and local audio/video: ${whisper ? `transcribed locally (${whisper.cmd[0]})` : 'transcribed with --transcribe (runs MLX Whisper / faster-whisper through pipx, ~150 MB once)'}.`
        : 'Metadata and search work. Transcripts need yt-dlp: YouTube now token-gates caption files.',
      fix: !cmd
        ? 'Install one of: `brew install yt-dlp`, `pipx install yt-dlp`, or just have pipx/uv on PATH (scour runs it ephemerally).'
        : !ffmpeg
          ? '`brew install ffmpeg` lets scour grab key frames so an AI can see the slides and code on screen.'
          : undefined,
      capabilities: [
        'video metadata', 'search',
        ...(cmd ? ['transcript', 'chapters', 'most replayed', 'comments', 'translations', 'sponsor cut'] : []),
        ...(cmd && ffmpeg ? ['key frames'] : []),
        ...(whisper || pipx ? ['local transcription'] : []),
      ],
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

async function fetchSegments(baseUrl: string, ctx: AdapterContext): Promise<Segment[]> {
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
  const res = await ctx.http.get(url, { timeoutMs: ctx.options.timeoutMs });
  // A 200 with an empty body means YouTube now wants a proof-of-origin token.
  if (!res.body.trim()) throw new Error('caption URL returned empty (token-gated)');
  return parseJson3(res.body);
}

/** yt-dlp comments → top-level comments by likes, each with its best replies. */
function commentTree(list: VideoInfo['comments'], videoId: string): Document[] {
  const roots = list.filter((x) => !x.parent || x.parent === 'root').sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 25);
  const node = (x: VideoInfo['comments'][number], kids: Document[] = []) => makeDoc({
    url: `https://www.youtube.com/watch?v=${videoId}&lc=${x.id ?? ''}`, source: 'youtube', nativeId: x.id, kind: 'comment',
    text: x.text, author: { name: x.author }, engagement: { score: x.likes },
    publishedAt: x.timestamp ? new Date(x.timestamp * 1000).toISOString() : undefined,
    children: kids.length ? kids : undefined,
    provenance: prov({ tier: Tier.Native, adapter: 'youtube', strategy: 'yt-dlp comments', finalUrl: `https://www.youtube.com/watch?v=${videoId}` }),
  });
  return roots.map((r) => node(r, list.filter((x) => x.parent === r.id).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 3).map((x) => node(x))));
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

const YT_COOLDOWN_KEY = 'route:youtube:rate-limited';
const YT_COOLDOWN_SEC = 45 * 60;

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
