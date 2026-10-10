import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configHome } from '../core/config.js';

/**
 * Logged-in sessions you create yourself with `scour login <site>`: a real
 * browser window opens on the site's own login page, you sign in there (scour
 * never sees your password), and the browser profile is kept on this machine
 * in ~/.scour/sessions/<site> (mode 0700). Later reads of that site render
 * with the profile, so they see what you see when logged in.
 *
 * Automating a logged-in account can be against a site's rules and can get
 * the account limited; use an account you can afford to lose.
 */
export interface SiteInfo {
  /** Folder name and display name: "x", "reddit", or a domain. */
  key: string;
  loginUrl: string;
  /** Hosts the session applies to. */
  hosts: RegExp;
  /** A cookie that exists only when logged in, to notice the login finished. */
  loggedInCookie?: string;
}

const KNOWN: Record<string, SiteInfo> = {
  x: { key: 'x', loginUrl: 'https://x.com/i/flow/login', hosts: /(^|\.)(x|twitter)\.com$/i, loggedInCookie: 'auth_token' },
  reddit: { key: 'reddit', loginUrl: 'https://www.reddit.com/login/', hosts: /(^|\.)reddit\.com$/i, loggedInCookie: 'reddit_session' },
  linkedin: { key: 'linkedin', loginUrl: 'https://www.linkedin.com/login', hosts: /(^|\.)linkedin\.com$/i, loggedInCookie: 'li_at' },
  instagram: { key: 'instagram', loginUrl: 'https://www.instagram.com/accounts/login/', hosts: /(^|\.)instagram\.com$/i, loggedInCookie: 'sessionid' },
  threads: { key: 'threads', loginUrl: 'https://www.threads.net/login', hosts: /(^|\.)threads\.(net|com)$/i, loggedInCookie: 'sessionid' },
};
const ALIASES: Record<string, string> = { twitter: 'x', 'x.com': 'x', 'twitter.com': 'x', 'reddit.com': 'reddit', 'linkedin.com': 'linkedin', 'instagram.com': 'instagram', 'threads.net': 'threads' };

/** "x", "twitter", "linkedin.com", "https://news.example.com/login" → the site. */
export function siteFor(input: string): SiteInfo {
  const raw = input.trim().toLowerCase();
  const known = KNOWN[ALIASES[raw] ?? raw];
  if (known) return known;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${input}" is not a site. Use a name like x, reddit, linkedin, or a domain like example.com.`);
  }
  const domain = url.hostname.replace(/^www\./, '');
  const viaAlias = KNOWN[ALIASES[domain] ?? ''];
  if (viaAlias) return viaAlias;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`"${input}" is not a site domain.`);
  return {
    key: domain,
    loginUrl: url.pathname.length > 1 ? url.href : `https://${url.hostname}/`,
    hosts: new RegExp(`(^|\\.)${domain.replace(/\./g, '\\.')}$`, 'i'),
  };
}

export function sessionsRoot(): string {
  return path.join(configHome(), 'sessions');
}

export function sessionDir(key: string): string {
  return path.join(sessionsRoot(), key.replace(/[^a-z0-9.-]/gi, '_'));
}

export interface SessionMeta {
  site: string;
  savedAt: string;
  /** Which browser made the profile; reads must use the same one. */
  channel?: 'chrome';
  loggedIn: boolean;
}

export async function writeMeta(key: string, meta: SessionMeta): Promise<void> {
  await fs.writeFile(path.join(sessionDir(key), 'scour-session.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export async function readMeta(key: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir(key), 'scour-session.json'), 'utf-8')) as SessionMeta;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(sessionsRoot());
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const n of names) {
    const m = await readMeta(n);
    if (m?.loggedIn) out.push(m);
  }
  return out;
}

/** The saved, logged-in session that covers this host, if any. */
export async function sessionForHost(host: string): Promise<{ key: string; dir: string; meta: SessionMeta } | null> {
  for (const m of await listSessions()) {
    if (siteFor(m.site).hosts.test(host)) return { key: m.site, dir: sessionDir(m.site), meta: m };
  }
  return null;
}

export async function removeSession(key: string): Promise<boolean> {
  const dir = sessionDir(siteFor(key).key);
  const existed = await fs.stat(dir).then(() => true, () => false);
  await fs.rm(dir, { recursive: true, force: true });
  return existed;
}
