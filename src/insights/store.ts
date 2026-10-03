import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configHome } from '../core/config.js';
import type { TrackedPost } from './analyze.js';

/**
 * Local dataset for topic tracking: ~/.scour/insights/<key>.json per topic.
 * Plain JSON, no database: a busy topic is a few hundred posts.
 */
export interface TrackedTopic {
  key: string;
  query: string;
  sources: string;
  createdAt: string;
  lastRunAt?: string;
  runs: number;
}

interface TopicFile { topic: TrackedTopic; posts: Record<string, TrackedPost> }

const MAX_POSTS = 1500;

function dir(): string {
  return path.join(configHome(), 'insights');
}

export function topicKey(query: string, sources = 'twitter'): string {
  const norm = `${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${sources.toLowerCase().split(/[,\s]+/).filter(Boolean).sort().join(',')}`;
  return createHash('sha256').update(norm).digest('hex').slice(0, 20);
}

async function read(key: string): Promise<TopicFile | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir(), `${key}.json`), 'utf-8')) as TopicFile;
  } catch {
    return null;
  }
}

async function write(f: TopicFile): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  // Keep the newest posts if a topic grows past the cap.
  const entries = Object.values(f.posts).sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')).slice(0, MAX_POSTS);
  const posts = Object.fromEntries(entries.map((p) => [p.id, p]));
  const file = path.join(dir(), `${f.topic.key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ topic: f.topic, posts }), 'utf-8');
  await fs.rename(tmp, file);
}

export async function loadTopic(query: string, sources?: string): Promise<{ topic: TrackedTopic; posts: TrackedPost[] } | null> {
  const f = await read(topicKey(query, sources));
  return f ? { topic: f.topic, posts: Object.values(f.posts) } : null;
}

export async function saveTopic(topic: TrackedTopic, posts: TrackedPost[]): Promise<void> {
  await write({ topic, posts: Object.fromEntries(posts.map((p) => [p.id, p])) });
}

export async function listTopics(): Promise<(TrackedTopic & { posts: number })[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir())).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: (TrackedTopic & { posts: number })[] = [];
  for (const n of names) {
    const f = await read(n.replace(/\.json$/, ''));
    if (f) out.push({ ...f.topic, posts: Object.keys(f.posts).length });
  }
  return out.sort((a, b) => a.query.localeCompare(b.query));
}

export async function removeTopic(query: string, sources?: string): Promise<boolean> {
  try {
    await fs.rm(path.join(dir(), `${topicKey(query, sources)}.json`));
    return true;
  } catch {
    return false;
  }
}
