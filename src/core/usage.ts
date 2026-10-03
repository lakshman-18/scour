import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configHome } from './config.js';

/**
 * Monthly usage counters for keyed providers, persisted in ~/.scour/usage.json.
 *
 * Several providers give a monthly free allowance and then bill a card on file
 * (Brave: $5 credit ≈ 1,000 queries, then $5/1k with no spending cap). The run
 * ledger only sees one process, so these counters are what keep you inside the
 * free allowance across every run, cron job and MCP session.
 */
export interface Allowance {
  /** Units per calendar month that cost nothing (provider free credits). */
  freePerMonth: number;
  /** USD per unit beyond the free allowance. */
  pricePerUnit: number;
}

export const ALLOWANCES: Record<string, Allowance> = {
  // $5/month credit at $5 per 1,000 requests; keep a small safety margin.
  brave: { freePerMonth: 950, pricePerUnit: 0.005 },
  // 1,000 free credits/month, no card; basic search = 1 credit.
  tavily: { freePerMonth: 950, pricePerUnit: 0.008 },
  // X API pay-per-use: no free allowance, $0.005 per post read.
  'x-api-posts': { freePerMonth: 0, pricePerUnit: 0.005 },
};

type UsageFile = Record<string, Record<string, number>>;

function file(): string {
  return path.join(configHome(), 'usage.json');
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

async function read(): Promise<UsageFile> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf-8')) as UsageFile;
  } catch {
    return {};
  }
}

export async function usedThisMonth(provider: string): Promise<number> {
  return (await read())[monthKey()]?.[provider] ?? 0;
}

export async function recordUsage(provider: string, units: number): Promise<void> {
  if (units <= 0) return;
  const data = await read();
  const m = monthKey();
  data[m] = { ...(data[m] ?? {}), [provider]: (data[m]?.[provider] ?? 0) + units };
  // Keep the last 12 months only.
  for (const k of Object.keys(data).sort().slice(0, -12)) delete data[k];
  await fs.mkdir(configHome(), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * The USD this many units will cost, given what's already been used this
 * month. Zero while inside the free allowance — so the default $0 cap lets
 * free-tier calls through and blocks the first one that would be billed.
 */
export async function costOf(provider: string, units: number): Promise<number> {
  const a = ALLOWANCES[provider];
  if (!a) return 0;
  const used = await usedThisMonth(provider);
  const billable = Math.max(0, used + units - a.freePerMonth) - Math.max(0, used - a.freePerMonth);
  return billable * a.pricePerUnit;
}

export async function usageSummary(): Promise<Record<string, { used: number; free: number }>> {
  const m = (await read())[monthKey()] ?? {};
  const out: Record<string, { used: number; free: number }> = {};
  for (const [k, a] of Object.entries(ALLOWANCES)) out[k] = { used: m[k] ?? 0, free: a.freePerMonth };
  return out;
}
