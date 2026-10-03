import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WatchResult } from './watch.js';

const exec = promisify(execFile);

/**
 * Where change alerts go. Specs are short strings so they fit on a command
 * line and in a watch's saved state:
 *
 *   slack:https://hooks.slack.com/services/…     Slack incoming webhook
 *   discord:https://discord.com/api/webhooks/…   Discord webhook
 *   telegram:<chat_id>@<bot_token>               Telegram bot message
 *   ntfy:<topic>  or  ntfy:https://host/topic    push to your phone via ntfy (free, no account)
 *   webhook:https://…   (or a bare https URL)    POST the full change as JSON (n8n, Zapier, Make…)
 *   macos                                        local notification centre banner
 */
export type NotifySpec = string;

export interface Notifier {
  kind: string;
  target: string;
  send(r: WatchResult): Promise<void>;
}

export function parseNotify(spec: NotifySpec): Notifier {
  const s = spec.trim();
  if (s === 'macos' || s === 'mac') return { kind: 'macos', target: 'notification centre', send: macos };
  const i = s.indexOf(':');
  const kind = /^https?:\/\//.test(s) ? 'webhook' : s.slice(0, i).toLowerCase();
  const rest = /^https?:\/\//.test(s) ? s : s.slice(i + 1);
  switch (kind) {
    case 'slack':
      requireHttps(rest, 'slack');
      return { kind, target: redact(rest), send: (r) => postJson(rest, { text: plain(r, 'slack') }) };
    case 'discord':
      requireHttps(rest, 'discord');
      return { kind, target: redact(rest), send: (r) => postJson(rest, { content: plain(r, 'discord').slice(0, 1990) }) };
    case 'telegram': {
      const at = rest.indexOf('@');
      if (at < 1) throw new Error('telegram notify must look like telegram:<chat_id>@<bot_token>');
      const chatId = rest.slice(0, at);
      const token = rest.slice(at + 1);
      return {
        kind, target: `chat ${chatId}`,
        send: (r) => postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId, text: plain(r, 'telegram').slice(0, 4000), disable_web_page_preview: true,
        }),
      };
    }
    case 'ntfy': {
      const url = /^https?:\/\//.test(rest) ? rest : `https://ntfy.sh/${encodeURIComponent(rest)}`;
      return { kind, target: url, send: (r) => ntfy(url, r) };
    }
    case 'webhook':
      requireHttps(rest, 'webhook', true);
      return { kind, target: redact(rest), send: (r) => postJson(rest, payload(r)) };
    default:
      throw new Error(`Unknown notify target "${spec}". Use slack:, discord:, telegram:, ntfy:, webhook: or macos.`);
  }
}

/** Send to every notifier; one failing channel never blocks the others. */
export async function notifyAll(notifiers: Notifier[], r: WatchResult): Promise<{ kind: string; ok: boolean; error?: string }[]> {
  return Promise.all(
    notifiers.map((n) =>
      n.send(r).then(
        () => ({ kind: n.kind, ok: true }),
        (err: Error) => ({ kind: n.kind, ok: false, error: err.message }),
      ),
    ),
  );
}

/** The JSON body for webhooks: everything a workflow tool needs, nothing heavy. */
export function payload(r: WatchResult): Record<string, unknown> {
  return {
    event: 'scour.watch.changed',
    label: r.label ?? null,
    url: r.url,
    kind: r.kind,
    checkedAt: r.checkedAt,
    previousSeenAt: r.previousSeenAt ?? null,
    newItems: r.newItems.map((n) => ({
      id: n.id, title: n.title ?? null, url: n.url, excerpt: n.excerpt ?? null,
      author: n.author?.handle ?? n.author?.name ?? null, publishedAt: n.publishedAt ?? null,
    })),
    diff: r.diff ?? null,
    summary: headline(r),
  };
}

export function headline(r: WatchResult): string {
  const name = r.label ?? safeHost(r.url);
  if (r.newItems.length) return `${name}: ${r.newItems.length} new item${r.newItems.length === 1 ? '' : 's'}`;
  return `${name}: page changed`;
}

/** Human text for chat apps: headline, up to 5 items with links, or a short diff. */
export function plain(r: WatchResult, flavour: 'slack' | 'discord' | 'telegram' | 'text' = 'text'): string {
  const lines = [flavour === 'slack' ? `*${headline(r)}*` : flavour === 'discord' ? `**${headline(r)}**` : headline(r)];
  for (const n of r.newItems.slice(0, 5)) {
    const title = (n.title ?? n.excerpt ?? n.url).replace(/\s+/g, ' ').slice(0, 140);
    lines.push(flavour === 'slack' ? `• <${n.url}|${title}>` : `• ${title}\n  ${n.url}`);
  }
  if (r.newItems.length > 5) lines.push(`…and ${r.newItems.length - 5} more`);
  if (!r.newItems.length && r.diff) lines.push(r.diff.split('\n').slice(0, 8).join('\n'));
  lines.push(r.url);
  return lines.join('\n');
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'scour-notify/0.1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}: ${(await res.text()).slice(0, 120)}`);
}

async function ntfy(url: string, r: WatchResult): Promise<void> {
  const first = r.newItems[0]?.url ?? r.url;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Title: headline(r).slice(0, 200), Click: first, Tags: 'eyes', 'User-Agent': 'scour-notify/0.1' },
    body: plain(r).slice(0, 3500),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ntfy`);
}

async function macos(r: WatchResult): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('macos notifications only work on macOS');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const body = r.newItems[0]?.title ?? (r.newItems.length ? '' : 'Content changed');
  await exec('osascript', ['-e', `display notification "${esc(body.slice(0, 200))}" with title "scour" subtitle "${esc(headline(r).slice(0, 120))}"`]);
}

function requireHttps(url: string, kind: string, allowLocalHttp = false): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${kind} notify needs a URL, got "${url}"`);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocalHttp && local)) throw new Error(`${kind} notify URL must be https`);
}

/** Webhook URLs are secrets; never print them in full. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '…';
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
