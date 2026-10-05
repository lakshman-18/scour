import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { configHome } from '../core/config.js';
import { normDate } from '../core/extract.js';
import { matchQuery, type ParsedQuery } from '../core/query.js';
import type { SearchResult } from '../core/types.js';
import { truncate } from './_helpers.js';

const exec = promisify(execFile);

/**
 * Your own X history, complete and free: X lets every account download an
 * archive of its data (Settings → Your account → Download an archive). Search
 * engines index only a sliver of small accounts' posts and the public timeline
 * shows the latest 20, so the archive is the only no-cost way to search
 * everything you've posted. We keep the posts and their counts; nothing else
 * from the archive (email, DMs, devices) is read.
 */
export interface ArchivePost {
  id: string;
  text: string;
  createdAt?: string;
  likes: number;
  reposts: number;
  replyTo?: string;
  media: boolean;
}

export interface XArchive {
  handle: string;
  name?: string;
  accountId?: string;
  importedAt: string;
  posts: ArchivePost[];
}

export function archiveDir(): string {
  return path.join(configHome(), 'x-archive');
}

export async function importXArchive(source: string): Promise<{ archive: XArchive; file: string }> {
  const files = await readArchiveFiles(source);
  const account = parseYtd<{ account?: { username?: string; accountId?: string; accountDisplayName?: string } }>(files, /(^|\/)account\.js$/)[0]?.account;
  if (!account?.username) throw new Error('No data/account.js in that archive. Point at the .zip X sent you, or the folder it unpacks to.');

  type RawTweet = {
    id_str: string; full_text?: string; created_at?: string; favorite_count?: string | number; retweet_count?: string | number;
    in_reply_to_screen_name?: string; entities?: { urls?: { url?: string; expanded_url?: string }[] };
    extended_entities?: { media?: unknown[] };
  };
  const raw = parseYtd<{ tweet?: RawTweet }>(files, /(^|\/)tweets?(-part\d+)?\.js$/).map((x) => x.tweet).filter((t): t is RawTweet => !!t?.id_str);
  if (!raw.length) throw new Error('The archive has no posts (data/tweets.js is missing or empty).');

  // Posts over 280 characters are cut short in tweets.js; the full text is in
  // note-tweet.js, keyed only by time.
  const notes = new Map<number, string>();
  for (const n of parseYtd<{ noteTweet?: { createdAt?: string; core?: { text?: string } } }>(files, /(^|\/)note-tweet(-part\d+)?\.js$/)) {
    const at = Date.parse(n.noteTweet?.createdAt ?? '');
    if (n.noteTweet?.core?.text && Number.isFinite(at)) notes.set(Math.floor(at / 1000), n.noteTweet.core.text);
  }

  const posts: ArchivePost[] = [];
  for (const t of raw) {
    let text = t.full_text ?? '';
    if (/^RT @\w+:/.test(text)) continue; // reposts of other people's posts
    const at = Date.parse(t.created_at ?? '');
    const long = Number.isFinite(at) ? notes.get(Math.floor(at / 1000)) : undefined;
    if (long && long.length > text.length) text = long;
    for (const u of t.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    posts.push({
      id: t.id_str,
      text: decode(text),
      createdAt: normDate(t.created_at),
      likes: Number(t.favorite_count) || 0,
      reposts: Number(t.retweet_count) || 0,
      replyTo: t.in_reply_to_screen_name || undefined,
      media: (t.extended_entities?.media?.length ?? 0) > 0,
    });
  }
  posts.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const archive: XArchive = {
    handle: account.username,
    name: account.accountDisplayName,
    accountId: account.accountId,
    importedAt: new Date().toISOString(),
    posts,
  };
  await fs.mkdir(archiveDir(), { recursive: true, mode: 0o700 });
  const file = path.join(archiveDir(), `${account.username.toLowerCase()}.json`);
  await fs.writeFile(file, JSON.stringify(archive), { mode: 0o600 });
  return { archive, file };
}

export async function listArchives(): Promise<XArchive[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(archiveDir())).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: XArchive[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(archiveDir(), n), 'utf-8')) as XArchive);
    } catch {
      // unreadable file; skip it
    }
  }
  return out;
}

/** Posts in your imported archives that satisfy the query, newest first. */
export async function searchArchives(q: ParsedQuery, limit: number): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  for (const a of await listArchives()) {
    if (q.from.length && !q.from.includes(a.handle.toLowerCase())) continue;
    for (const p of a.posts) {
      const r = toResult(a, p);
      if (matchQuery(r, q, { complete: true }).ok) out.push(r);
    }
  }
  return out.sort((x, y) => (y.publishedAt ?? '').localeCompare(x.publishedAt ?? '')).slice(0, limit);
}

function toResult(a: XArchive, p: ArchivePost): SearchResult {
  return {
    title: truncate(p.text.replace(/\s+/g, ' '), 100),
    url: `https://x.com/${a.handle}/status/${p.id}`,
    snippet: p.text,
    source: 'twitter',
    publishedAt: p.createdAt,
    author: { handle: a.handle, name: a.name },
    engagement: { score: p.likes, shares: p.reposts },
    extra: { via: `your X archive (counts as of ${a.importedAt.slice(0, 10)})`, ...(p.replyTo ? { replyTo: p.replyTo } : {}) },
  };
}

async function readArchiveFiles(source: string): Promise<Map<string, string>> {
  const want = /(^|\/)data\/(account|tweets?(-part\d+)?|note-tweet(-part\d+)?)\.js$/;
  const out = new Map<string, string>();
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) throw new Error(`${source} not found`);
  if (stat.isDirectory()) {
    const dataDir = (await fs.stat(path.join(source, 'data')).catch(() => null))?.isDirectory() ? path.join(source, 'data') : source;
    for (const n of await fs.readdir(dataDir)) {
      if (want.test(`data/${n}`)) out.set(`data/${n}`, await fs.readFile(path.join(dataDir, n), 'utf-8'));
    }
    return out;
  }
  // A .zip: list it, then stream out only the files we need.
  let listing: string;
  try {
    listing = (await exec('unzip', ['-Z1', source], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('`unzip` is not installed; unzip the archive and pass the folder instead.');
    throw new Error(`${source} is not a readable .zip archive`);
  }
  for (const name of listing.split('\n').map((l) => l.trim()).filter((l) => want.test(l))) {
    const { stdout } = await exec('unzip', ['-p', source, name], { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' });
    out.set(name, stdout);
  }
  return out;
}

/** Archive files are JavaScript: `window.YTD.tweets.part0 = [ … ]`. */
function parseYtd<T>(files: Map<string, string>, name: RegExp): T[] {
  const out: T[] = [];
  for (const [file, body] of files) {
    if (!name.test(file)) continue;
    const json = body.slice(body.indexOf('=') + 1).trim();
    try {
      out.push(...(JSON.parse(json) as T[]));
    } catch {
      throw new Error(`Could not parse ${file} in the archive`);
    }
  }
  return out;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
