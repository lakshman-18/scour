import { Registry } from './core/registry.js';
import { Scour } from './core/pipeline.js';
import { loadConfig } from './core/config.js';
import { genericAdapter } from './adapters/generic.js';
import { redditAdapter } from './adapters/reddit.js';
import { hackerNewsAdapter } from './adapters/hackernews.js';
import { githubAdapter } from './adapters/github.js';
import { youtubeAdapter } from './adapters/youtube.js';
import { twitterAdapter } from './adapters/twitter.js';
import { rssAdapter } from './adapters/rss.js';
import { wikipediaAdapter, stackOverflowAdapter } from './adapters/knowledge.js';
import { webSearchAdapter } from './search/websearch.js';
import { blueskyAdapter } from './adapters/bluesky.js';
import { arxivAdapter } from './adapters/arxiv.js';
import { npmAdapter, pypiAdapter } from './adapters/registries.js';
import type { Logger, ScourConfig } from './core/types.js';

/** Every adapter shipped in the box. */
export function defaultRegistry(): Registry {
  return new Registry().register(
    redditAdapter,
    hackerNewsAdapter,
    githubAdapter,
    youtubeAdapter,
    twitterAdapter,
    wikipediaAdapter,
    stackOverflowAdapter,
    blueskyAdapter,
    arxivAdapter,
    npmAdapter,
    pypiAdapter,
    rssAdapter,
    webSearchAdapter,
    genericAdapter, // priority -100: always the fallback
  );
}

/** One-liner factory. `const s = await createScour(); await s.get(url)`. */
export async function createScour(
  overrides: Partial<ScourConfig> = {},
  logger?: Logger,
): Promise<Scour> {
  const config = await loadConfig(overrides);
  return new Scour({ config, registry: defaultRegistry(), logger });
}

export { Scour, Registry };
export * from './core/types.js';
export { loadConfig, saveCredentials, parseTier, configHome } from './core/config.js';
export { FileCache, NullCache } from './core/cache.js';
export { ConsoleLogger } from './core/logger.js';
export { extractFromHtml, clip } from './core/extract.js';
export { canonicalUrl, normaliseUrl } from './core/pipeline.js';
export { watch, type WatchResult } from './workflows/watch.js';
export { crawl, type CrawlResult } from './workflows/crawl.js';
export { batch, type BatchResult } from './workflows/batch.js';
