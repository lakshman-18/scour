import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configHome } from '../core/config.js';
import type { Scour } from '../core/pipeline.js';
import { watchAll, listWatches } from '../workflows/watch.js';
import { parseNotify, notifyAll, redact } from '../workflows/notify.js';
import type { WatchResult } from '../workflows/watch.js';
import { scourEntrypoint } from '../setup.js';

const exec = promisify(execFile);

/**
 * Background service: keeps watches and tracked topics running without a
 * terminal, and sends one daily digest instead of a ping per item.
 *
 * macOS: a per-user LaunchAgent that runs `scour service tick` every N
 * minutes. Elsewhere: we print the equivalent crontab line.
 */
export interface ServiceConfig {
  /** Minutes between ticks (watches are checked every tick). */
  everyMinutes: number;
  /** Minutes between tracked-topic collections (they use search quota). */
  trackEveryMinutes: number;
  /** Local time for the daily digest, "HH:MM". Empty to disable. */
  digestAt: string;
  /** Where the digest goes (notify specs). Always also saved to ~/.scour/digests. */
  notify: string[];
  lastTickAt?: string;
  lastTrackAt?: string;
  lastDigestAt?: string;
}

interface QueuedItem { watch: string; title: string; url: string; at: string }

export const LABEL = 'dev.scour.agent';
const home = () => configHome();
const cfgFile = () => path.join(home(), 'service.json');
const queueFile = () => path.join(home(), 'digest-queue.json');
const lockFile = () => path.join(home(), 'service.lock');
const logFile = () => path.join(home(), 'logs', 'service.log');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export async function readServiceConfig(): Promise<ServiceConfig> {
  try {
    return { ...defaults(), ...JSON.parse(await fs.readFile(cfgFile(), 'utf-8')) };
  } catch {
    return defaults();
  }
}

function defaults(): ServiceConfig {
  return { everyMinutes: 30, trackEveryMinutes: 180, digestAt: '08:00', notify: ['macos'] };
}

async function writeServiceConfig(c: ServiceConfig): Promise<void> {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  await fs.writeFile(cfgFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ------------------------------------------------------------------ install

export async function install(opts: Partial<ServiceConfig>): Promise<{ how: string; detail: string }> {
  const prev = await readServiceConfig();
  const cfg: ServiceConfig = { ...prev, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (cfg.everyMinutes < 5) throw new Error('--every must be at least 5 minutes');
  if (cfg.digestAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.digestAt)) throw new Error('--digest must look like 08:00 (24-hour)');
  for (const n of cfg.notify) parseNotify(n);
  await writeServiceConfig(cfg);
  await fs.mkdir(path.dirname(logFile()), { recursive: true });

  const { node, script } = scourEntrypoint();
  if (process.platform !== 'darwin') {
    return {
      how: 'cron',
      detail: `Add this line with \`crontab -e\`:\n*/${cfg.everyMinutes} * * * * "${node}" "${script}" service tick >> "${logFile()}" 2>&1`,
    };
  }

  const env: Record<string, string> = { PATH: [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':') };
  if (process.env.SCOUR_HOME) env.SCOUR_HOME = process.env.SCOUR_HOME;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(script)}</string><string>service</string><string>tick</string></array>
  <key>StartInterval</key><integer>${cfg.everyMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile())}</string>
  <key>StandardErrorPath</key><string>${xml(logFile())}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(plistPath()), { recursive: true });
  await fs.writeFile(plistPath(), plist, 'utf-8');
  const domain = `gui/${os.userInfo().uid}`;
  await exec('launchctl', ['bootout', domain, plistPath()]).catch(() => {}); // replace a previous install
  await exec('launchctl', ['bootstrap', domain, plistPath()]);
  return { how: 'launchd', detail: plistPath() };
}

export async function uninstall(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const existed = await fs.access(plistPath()).then(() => true, () => false);
  await exec('launchctl', ['bootout', `gui/${os.userInfo().uid}`, plistPath()]).catch(() => {});
  await fs.rm(plistPath(), { force: true });
  return existed;
}

export async function status(): Promise<{ installed: boolean; loaded: boolean; config: ServiceConfig; nextDigest?: string; recentLog: string[]; watches: number; topics: number }> {
  const installed = await fs.access(plistPath()).then(() => true, () => false);
  let loaded = false;
  if (process.platform === 'darwin') {
    loaded = await exec('launchctl', ['print', `gui/${os.userInfo().uid}/${LABEL}`]).then(() => true, () => false);
  }
  const config = await readServiceConfig();
  const log = await fs.readFile(logFile(), 'utf-8').catch(() => '');
  const { listTopics } = await import('../insights/store.js');
  return {
    installed, loaded, config,
    nextDigest: config.digestAt ? nextAt(config.digestAt).toISOString() : undefined,
    recentLog: log.trim().split('\n').slice(-8),
    watches: (await listWatches()).length,
    topics: (await listTopics()).length,
  };
}

// ------------------------------------------------------------------ tick

/**
 * One scheduled run. Never throws: a failure in one part (site down, quota
 * hit) must not stop the others or the next tick.
 */
export async function tick(scour: Scour, opts: { forceDigest?: boolean; forceTrack?: boolean } = {}): Promise<string[]> {
  const log: string[] = [];
  const say = (m: string) => log.push(`${new Date().toISOString().slice(0, 19)} ${m}`);
  if (!(await acquireLock())) {
    say('previous tick still running; skipping');
    return log;
  }
  try {
    const cfg = await readServiceConfig();
    const now = new Date();

    // 1. Watches. Those with their own alert targets alert as usual; every
    //    new item also goes into the digest queue.
    try {
      const results = await watchAll(scour, {});
      const changed = results.filter((r) => r.changed);
      for (const r of changed) {
        const specs = r.notify ?? [];
        if (specs.length) await notifyAll(specs.map(parseNotify), r);
      }
      await enqueue(changed);
      say(`watches: ${results.length} checked, ${changed.length} changed`);
    } catch (err) {
      say(`watches failed: ${(err as Error).message.split('\n')[0]}`);
    }

    // 2. Tracked topics, at their own slower pace (they spend search quota).
    const trackDue = opts.forceTrack || !cfg.lastTrackAt || now.getTime() - Date.parse(cfg.lastTrackAt) >= cfg.trackEveryMinutes * 60_000;
    if (trackDue) {
      try {
        const { listTopics } = await import('../insights/store.js');
        const { collect } = await import('../insights/collect.js');
        const topics = await listTopics();
        for (const t of topics) {
          const r = await collect(scour, t.query, { sources: t.sources });
          say(`topic "${t.query}": +${r.added} new, ${r.refreshed} re-checked`);
        }
        cfg.lastTrackAt = now.toISOString();
      } catch (err) {
        say(`topics failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }

    // 3. Daily digest.
    const due = cfg.digestAt && (opts.forceDigest || isDigestDue(cfg.digestAt, cfg.lastDigestAt, now));
    if (due) {
      try {
        const file = await sendDigest(cfg, now);
        cfg.lastDigestAt = now.toISOString();
        say(`digest sent: ${file}`);
      } catch (err) {
        say(`digest failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }

    cfg.lastTickAt = now.toISOString();
    await writeServiceConfig(cfg);
  } finally {
    await releaseLock();
  }
  return log;
}

/** True once today's digest time has passed and no digest has gone out since. */
export function isDigestDue(at: string, lastDigestAt: string | undefined, now = new Date()): boolean {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const today = new Date(now);
  today.setHours(h, m, 0, 0);
  if (now < today) return false;
  return !lastDigestAt || Date.parse(lastDigestAt) < today.getTime();
}

function nextAt(at: string, now = new Date()): Date {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

// ------------------------------------------------------------------ digest

async function enqueue(changed: WatchResult[]): Promise<void> {
  if (!changed.length) return;
  const q = await readQueue();
  for (const r of changed) {
    const label = r.label ?? r.url;
    if (r.newItems.length) for (const n of r.newItems) q.push({ watch: label, title: (n.title ?? n.excerpt ?? n.url).replace(/\s+/g, ' ').slice(0, 160), url: n.url, at: r.checkedAt });
    else q.push({ watch: label, title: 'Page changed', url: r.url, at: r.checkedAt });
  }
  await fs.writeFile(queueFile(), JSON.stringify(q.slice(-500)), 'utf-8');
}

async function readQueue(): Promise<QueuedItem[]> {
  try {
    return JSON.parse(await fs.readFile(queueFile(), 'utf-8')) as QueuedItem[];
  } catch {
    return [];
  }
}

export async function buildDigest(since: string | undefined, now = new Date()): Promise<{ markdown: string; summary: string; items: number }> {
  const queue = (await readQueue()).filter((q) => !since || q.at > since);
  const { listTopics, loadTopic } = await import('../insights/store.js');
  const { compareTopics, analyze } = await import('../insights/analyze.js');
  const { renderComparison } = await import('../insights/render.js');
  const topics = await listTopics();
  const data = [];
  for (const t of topics) {
    const d = await loadTopic(t.query, t.sources);
    if (d) data.push({ topic: t.query, posts: d.posts });
  }

  const day = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const md: string[] = [`# scour digest — ${day}`, ''];
  md.push(`_Since ${since ? new Date(since).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'the service started'} · ${queue.length} new on watches · ${topics.length} tracked topics_`, '');

  const headline: string[] = [];
  if (data.length) {
    const rows = compareTopics(data, now.getTime());
    md.push(renderComparison(rows).replace(/^# Which topic is winning/, '## Topics: which is winning'), '');
    if (rows[0]) headline.push(`Leading: ${rows[0].topic}`);
    for (const d of data) {
      const r = analyze(d.topic, d.posts, now.getTime());
      const fresh = d.posts.filter((p) => !since || p.firstSeenAt > since).length;
      md.push(`### ${d.topic}`, `- ${fresh} new post${fresh === 1 ? '' : 's'} found since the last digest`);
      if (r.rising[0]) md.push(`- Rising: +${Math.round(r.rising[0].perHour)} likes/hour — ${r.rising[0].text.replace(/\s+/g, ' ').slice(0, 120)}\n  ${r.rising[0].url}`);
      if (r.findings[0]) md.push(`- Pattern: ${r.findings[0]}`);
      md.push('');
    }
  }

  if (queue.length) {
    md.push('## New on your watches', '');
    const byWatch = new Map<string, QueuedItem[]>();
    for (const q of queue) byWatch.set(q.watch, [...(byWatch.get(q.watch) ?? []), q]);
    for (const [w, items] of byWatch) {
      md.push(`### ${w} (${items.length})`);
      for (const it of items.slice(0, 10)) md.push(`- [${it.title}](${it.url})`);
      if (items.length > 10) md.push(`- …and ${items.length - 10} more`);
      md.push('');
    }
    headline.push(`${queue.length} new on watches`);
  } else md.push('_Nothing new on your watches._', '');

  return { markdown: md.join('\n').trim(), summary: headline.join(' · ') || 'Nothing new today', items: queue.length };
}

async function sendDigest(cfg: ServiceConfig, now: Date): Promise<string> {
  const d = await buildDigest(cfg.lastDigestAt, now);
  const dir = path.join(home(), 'digests');
  await fs.mkdir(dir, { recursive: true });
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const file = path.join(dir, `${local}.md`);
  await fs.writeFile(file, d.markdown, 'utf-8');

  if (cfg.notify.length) {
    // Chat apps get the readable digest; it's also linked as a file locally.
    const pseudo = {
      url: `file://${file}`, label: 'scour digest', headline: `scour digest · ${d.summary}`, changed: true, kind: 'new-items' as const,
      newItems: [{ id: 'digest', url: `file://${file}`, title: d.summary, excerpt: d.markdown.slice(0, 1500), source: 'scour', kind: 'listing' as const, text: '', provenance: {} as never }],
      document: {} as never, checkedAt: now.toISOString(),
    };
    await notifyAll(cfg.notify.map(parseNotify), pseudo);
  }
  // Clear what was delivered.
  const remaining = (await readQueue()).filter((q) => q.at > now.toISOString());
  await fs.writeFile(queueFile(), JSON.stringify(remaining), 'utf-8');
  return file;
}

// ------------------------------------------------------------------ helpers

async function acquireLock(): Promise<boolean> {
  try {
    const h = await fs.open(lockFile(), 'wx');
    await h.writeFile(String(process.pid));
    await h.close();
    return true;
  } catch {
    // A lock older than 2 hours is from a crashed run.
    const st = await fs.stat(lockFile()).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 2 * 3600_000) {
      await fs.rm(lockFile(), { force: true });
      return acquireLock();
    }
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await fs.rm(lockFile(), { force: true });
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { redact };
