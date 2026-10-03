import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

/**
 * One command to plug scour into the AI tools you already use.
 * Every change is idempotent, backed up where it edits a file, and reversible
 * with --remove.
 */
export type Target = 'claude-code' | 'claude-desktop' | 'cursor' | 'skill';

export interface SetupStep {
  target: Target;
  action: 'added' | 'updated' | 'already' | 'removed' | 'absent' | 'skipped' | 'would-add' | 'would-remove' | 'failed';
  detail: string;
}

export function scourEntrypoint(): { node: string; script: string } {
  // dist/setup.js → ../bin/scour.js. Absolute paths, because GUI apps don't
  // inherit nvm/brew PATH and would fail to find `scour` or `node`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return { node: process.execPath, script: path.resolve(here, '..', 'bin', 'scour.js') };
}

export async function runSetup(targets: Target[], opts: { remove?: boolean; dryRun?: boolean } = {}): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  for (const t of targets) {
    try {
      if (t === 'claude-code') steps.push(await claudeCode(opts));
      else if (t === 'claude-desktop') steps.push(await jsonConfig(t, claudeDesktopConfigPath(), opts));
      else if (t === 'cursor') steps.push(await jsonConfig(t, path.join(os.homedir(), '.cursor', 'mcp.json'), opts));
      else if (t === 'skill') steps.push(await skill(opts));
    } catch (err) {
      steps.push({ target: t, action: 'failed', detail: (err as Error).message.split('\n')[0]! });
    }
  }
  return steps;
}

async function claudeCode(opts: { remove?: boolean; dryRun?: boolean }): Promise<SetupStep> {
  const { node, script } = scourEntrypoint();
  let exists = false;
  try {
    await exec('claude', ['mcp', 'get', 'scour'], { timeout: 30_000 });
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { target: 'claude-code', action: 'skipped', detail: '`claude` CLI not found on PATH' };
    }
  }
  if (opts.remove) {
    if (!exists) return { target: 'claude-code', action: 'absent', detail: 'no scour MCP server registered' };
    if (opts.dryRun) return { target: 'claude-code', action: 'would-remove', detail: 'claude mcp remove scour -s user' };
    await exec('claude', ['mcp', 'remove', 'scour', '-s', 'user'], { timeout: 30_000 });
    return { target: 'claude-code', action: 'removed', detail: 'user-scope MCP server' };
  }
  if (exists) return { target: 'claude-code', action: 'already', detail: 'scour MCP server is registered' };
  const args = ['mcp', 'add', '--scope', 'user', 'scour', '--', node, script, 'mcp'];
  if (opts.dryRun) return { target: 'claude-code', action: 'would-add', detail: `claude ${args.join(' ')}` };
  await exec('claude', args, { timeout: 30_000 });
  return { target: 'claude-code', action: 'added', detail: 'user-scope MCP server (all projects)' };
}

function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** Claude Desktop and Cursor share the `mcpServers` JSON shape. */
async function jsonConfig(target: Target, file: string, opts: { remove?: boolean; dryRun?: boolean }): Promise<SetupStep> {
  const { node, script } = scourEntrypoint();
  let config: { mcpServers?: Record<string, unknown> } = {};
  let existed = false;
  try {
    config = JSON.parse(await fs.readFile(file, 'utf-8'));
    existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} exists but is not valid JSON; not touching it`);
  }
  const has = !!config.mcpServers?.scour;
  const entry = { command: node, args: [script, 'mcp'] };

  if (opts.remove) {
    if (!has) return { target, action: 'absent', detail: file };
    if (opts.dryRun) return { target, action: 'would-remove', detail: file };
    delete config.mcpServers!.scour;
  } else {
    if (has && JSON.stringify(config.mcpServers!.scour) === JSON.stringify(entry)) return { target, action: 'already', detail: file };
    if (opts.dryRun) return { target, action: 'would-add', detail: file };
    config.mcpServers = { ...(config.mcpServers ?? {}), scour: entry };
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (existed) await fs.copyFile(file, `${file}.scour-backup`);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return {
    target,
    action: opts.remove ? 'removed' : has ? 'updated' : 'added',
    detail: `${file}${existed ? ' (backup: .scour-backup)' : ''} — restart the app to load it`,
  };
}

function skillPath(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'scour', 'SKILL.md');
}

async function skill(opts: { remove?: boolean; dryRun?: boolean }): Promise<SetupStep> {
  const file = skillPath();
  const exists = await fs.access(file).then(() => true, () => false);
  if (opts.remove) {
    if (!exists) return { target: 'skill', action: 'absent', detail: file };
    if (opts.dryRun) return { target: 'skill', action: 'would-remove', detail: file };
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    return { target: 'skill', action: 'removed', detail: file };
  }
  const content = skillMarkdown();
  if (exists && (await fs.readFile(file, 'utf-8')) === content) return { target: 'skill', action: 'already', detail: file };
  if (opts.dryRun) return { target: 'skill', action: 'would-add', detail: file };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf-8');
  return { target: 'skill', action: exists ? 'updated' : 'added', detail: file };
}

export function skillMarkdown(): string {
  const { node, script } = scourEntrypoint();
  return `---
name: scour
description: Read or search the live web for free with scour — any URL as clean Markdown (Reddit threads with comments, tweets, YouTube transcripts, GitHub repos/issues, HN, Stack Overflow, Wikipedia, RSS, docs, articles), topic search across Reddit/HN/GitHub/YouTube/X/the web at once, site maps and crawls, change monitoring, and CSS-selector extraction to JSON. Use whenever a task needs current information from the internet, the content behind a link, what people are saying about a topic, or data pulled from web pages.
---

# scour: free web access

Prefer the scour MCP tools when they are available; otherwise call the CLI via Bash.
Everything runs locally and costs $0 by default. Results are cached, so re-reading a URL is instant.

## Pick the right tool

| Need | MCP tool | CLI |
|---|---|---|
| Content of a URL (article, thread, tweet, video, repo, issue, docs page) | \`scour_read\` | \`scour get URL\` |
| Several URLs at once | \`scour_read_many\` | \`scour get URL1 URL2 …\` |
| What's out there on a topic | \`scour_search\` (no source = all platforms) | \`scour search "topic"\` |
| Topic on one platform | \`scour_search\` with \`source\`: reddit, hn, github, youtube, twitter, stackoverflow, wikipedia, websearch | \`scour search "topic" -s reddit\` |
| Every page on a site / docs | \`scour_crawl\` | \`scour map URL\` (list) · \`scour crawl URL\` (read) |
| Has this page/feed changed? | \`scour_watch\` | \`scour watch URL\` |
| Structured fields from a page | \`scour_extract\` | \`scour extract URL --list SEL -f name=SEL\` |

## How to work well

- **Research a topic:** search first (all platforms), then read the 3–6 most relevant results in full with \`scour_read_many\`. Cite the URLs you read.
- **"What do people think of X":** search with source \`reddit\`, \`hn\` and \`twitter\`, then read the top threads — the comments are included and are usually the point.
- **YouTube:** \`scour_read\` returns the transcript; summarise from it rather than from the title.
- **Images:** text never describes charts, screenshots or dashboards. When a page has images (the result says so), call \`scour_read\` again with \`images: N\` to see them, and use what they show: they often hold the actual evidence.
- **X/Twitter:** tweet URLs always work with no account, and a tweet that carries a long-form X Article returns the full article. Topic search (\`source: "twitter"\`) finds indexed popular tweets for free; for live, complete results the user can configure the official X API (\`scour auth x-api\`, $0.005/post, only used when they allow spend).
- **Long pages:** pass \`max_tokens\` to \`scour_read\` to keep context small.
- Each result ends with a provenance line (tier, time, $). Tier "cache" means free and instant.

## When something fails

- Run \`scour doctor\` — it lists what works on this machine and the exact fix for anything that doesn't.
- "needs the headless tier": the page is JavaScript-only; retry with \`max_tier: "headless"\`.
- Web search empty / CAPTCHA: keyless engines rate-limit. Suggest \`scour auth tavily\` (free, 1,000 searches/month, no card).
- Never ask the user for passwords or to paste API keys/cookies into chat. They run \`scour auth <service>\` themselves, which prompts with hidden input.
- scour never solves CAPTCHAs or bypasses bot protection. If a site blocks it, say so; don't look for workarounds.

CLI path if \`scour\` is not on PATH: \`"${node}" "${script}"\`
`;
}
