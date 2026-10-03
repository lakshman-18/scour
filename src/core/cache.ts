import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CacheEntry, CacheStore } from './types.js';

export function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

/** Deterministic JSON so the same document always hashes the same. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Content-addressed filesystem cache. No native dependency, no daemon, no
 * schema migrations — just sharded JSON files. This is the single biggest
 * cost lever in the product: a cache hit is tier 0 and costs nothing.
 */
export class FileCache implements CacheStore {
  constructor(private dir: string) {}

  private pathFor(key: string): string {
    const h = hashKey(key);
    // Two-level sharding keeps any one directory under a few thousand entries.
    return path.join(this.dir, h.slice(0, 2), h.slice(2, 4), `${h}.json`);
  }

  async get<T>(key: string, ttlSec?: number): Promise<CacheEntry<T> | null> {
    const entry = await this.getStale<T>(key);
    if (!entry) return null;
    const expiry = ttlSec === undefined ? entry.expiresAt : entry.storedAt + ttlSec * 1000;
    if (Date.now() > expiry) return null;
    return entry;
  }

  async getStale<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = await fs.readFile(this.pathFor(key), 'utf-8');
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  async set<T>(
    key: string,
    value: T,
    ttlSec: number,
    meta?: { etag?: string; lastModified?: string },
  ): Promise<void> {
    const file = this.pathFor(key);
    const entry: CacheEntry<T> = {
      key,
      value,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlSec * 1000,
      etag: meta?.etag,
      lastModified: meta?.lastModified,
      hash: stableHash(value),
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written entry.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf-8');
    await fs.rename(tmp, file);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async clear(): Promise<number> {
    const { entries } = await this.stats();
    await fs.rm(this.dir, { recursive: true, force: true });
    return entries;
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    const walk = async (d: string): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) await walk(p);
        else if (it.name.endsWith('.json')) {
          entries++;
          bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(this.dir);
    return { entries, bytes };
  }

  /** Drop every entry whose expiry has passed. Returns how many went. */
  async prune(): Promise<number> {
    let removed = 0;
    const now = Date.now();
    const walk = async (d: string): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) await walk(p);
        else if (it.name.endsWith('.json')) {
          try {
            const e = JSON.parse(await fs.readFile(p, 'utf-8')) as CacheEntry;
            if (now > e.expiresAt) {
              await fs.rm(p, { force: true });
              removed++;
            }
          } catch {
            await fs.rm(p, { force: true });
            removed++;
          }
        }
      }
    };
    await walk(this.dir);
    return removed;
  }
}

/** Drop-in no-op cache for `--no-cache` runs and tests. */
export class NullCache implements CacheStore {
  async get<T>(): Promise<CacheEntry<T> | null> {
    return null;
  }
  async getStale<T>(): Promise<CacheEntry<T> | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<number> {
    return 0;
  }
  async stats(): Promise<{ entries: number; bytes: number }> {
    return { entries: 0, bytes: 0 };
  }
}
