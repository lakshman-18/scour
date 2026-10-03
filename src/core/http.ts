import type { HttpClient, HttpInit, HttpResponse, Logger } from './types.js';

/**
 * Rotating pool of real browser User-Agents. Not evasion for its own sake —
 * a lot of sites 403 the default Node UA and then happily serve the same
 * public bytes to a normal-looking client. We are asking for public pages
 * the way a browser asks for them.
 */
export const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Per-host politeness: never hammer one origin, even across concurrent calls. */
class HostThrottle {
  private last = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();

  constructor(private delayMs: number) {}

  async wait(host: string): Promise<void> {
    if (this.delayMs <= 0) return;
    const prev = this.queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.queues.set(host, prev.then(() => next));
    await prev;
    const since = Date.now() - (this.last.get(host) ?? 0);
    if (since < this.delayMs) await sleep(this.delayMs - since);
    this.last.set(host, Date.now());
    // Release on the next tick so the following caller waits for *our* delay too.
    setTimeout(release, 0);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface HttpClientOptions {
  userAgent?: string;
  defaultTimeoutMs?: number;
  politenessMs?: number;
  proxy?: string;
  log?: Logger;
  /** Max bytes to read from a single response. Default 20 MB. */
  maxBytes?: number;
}

export class FetchHttpClient implements HttpClient {
  private _bytes = 0;
  private throttle: HostThrottle;
  private ua: string;
  private maxBytes: number;

  constructor(private opts: HttpClientOptions = {}) {
    this.throttle = new HostThrottle(opts.politenessMs ?? 0);
    this.ua = opts.userAgent ?? randomUserAgent();
    this.maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  }

  get bytes(): number {
    return this._bytes;
  }

  async get(url: string, init: HttpInit = {}): Promise<HttpResponse> {
    return this.request('GET', url, undefined, init);
  }

  async post(url: string, body: unknown, init: HttpInit = {}): Promise<HttpResponse> {
    return this.request('POST', url, body, init);
  }

  async json<T = unknown>(url: string, init: HttpInit = {}): Promise<T> {
    const res = await this.get(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new HttpError(
        `Expected JSON from ${url} but got ${res.body.slice(0, 120)}…`,
        res.status,
        url,
        res.body.slice(0, 500),
      );
    }
  }

  private async request(
    method: string,
    url: string,
    body: unknown,
    init: HttpInit,
  ): Promise<HttpResponse> {
    const retries = init.retries ?? 2;
    const timeoutMs = init.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const allow = new Set(init.allowStatus ?? []);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (init.signal?.aborted) throw init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted');
      try {
        const host = new URL(url).host;
        await this.throttle.wait(host);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        if (init.signal) {
          if (init.signal.aborted) controller.abort(init.signal.reason);
          else init.signal.addEventListener('abort', () => controller.abort(init.signal!.reason), { once: true });
        }

        const headers: Record<string, string> = {
          ...BROWSER_HEADERS,
          'User-Agent': this.ua,
          ...init.headers,
        };
        if (init.revalidate?.etag) headers['If-None-Match'] = init.revalidate.etag;
        if (init.revalidate?.lastModified) headers['If-Modified-Since'] = init.revalidate.lastModified;

        let payload: string | undefined;
        if (body !== undefined) {
          if (typeof body === 'string') {
            payload = body;
            headers['Content-Type'] ??= init.contentType ?? 'application/x-www-form-urlencoded';
          } else {
            payload = JSON.stringify(body);
            headers['Content-Type'] ??= init.contentType ?? 'application/json';
          }
        }

        const dispatcher = await this.dispatcherFor(init.proxy ?? this.opts.proxy);

        const res = await fetch(url, {
          method,
          headers,
          body: payload,
          redirect: init.redirect ?? 'follow',
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        clearTimeout(timer);

        if (res.status === 304) {
          return {
            status: 304,
            url: res.url || url,
            headers: headerMap(res.headers),
            body: '',
            bytes: 0,
            notModified: true,
          };
        }

        const { text, raw } = await this.readCapped(res);
        this._bytes += raw.length;

        if (!res.ok && !allow.has(res.status)) {
          // 4xx is a definitive answer; do not burn retries on it (429 excepted).
          const retryable = res.status >= 500 || res.status === 429;
          const err = new HttpError(
            `HTTP ${res.status} ${res.statusText} for ${url}`,
            res.status,
            url,
            text.slice(0, 500),
          );
          if (!retryable || attempt === retries) throw err;
          lastErr = err;
          await sleep(backoff(attempt, res.headers.get('retry-after')));
          continue;
        }

        return {
          status: res.status,
          url: res.url || url,
          headers: headerMap(res.headers),
          body: text,
          bytes: raw.length,
          raw,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        if (init.signal?.aborted) throw err; // cancelled by the caller: retrying would be wasted work
        if (attempt === retries) break;
        this.opts.log?.debug(`retry ${attempt + 1}/${retries} for ${url}: ${(err as Error).message}`);
        await sleep(backoff(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Stream-read with a hard byte cap so one huge page can't OOM the process. */
  private async readCapped(res: Response): Promise<{ text: string; raw: Buffer }> {
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > this.maxBytes) {
      throw new HttpError(`Response too large: ${len} bytes > cap ${this.maxBytes}`, res.status, res.url);
    }
    if (!res.body) {
      const raw = Buffer.from(await res.arrayBuffer());
      return { text: raw.toString('utf-8'), raw };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        throw new HttpError(`Response exceeded ${this.maxBytes} byte cap`, res.status, res.url);
      }
      chunks.push(value);
    }
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    // Binary bodies are not worth decoding as text.
    if (/^(application\/(pdf|octet-stream|zip|vnd\.)|image\/|audio\/|video\/)/i.test(res.headers.get('content-type') ?? '')) {
      return { text: '', raw: buf };
    }
    try {
      return { text: new TextDecoder(charset || 'utf-8', { fatal: false }).decode(buf), raw: buf };
    } catch {
      return { text: buf.toString('utf-8'), raw: buf };
    }
  }

  private dispatcherCache: unknown | null | undefined;
  /** Lazily build an undici ProxyAgent only if a proxy is configured. */
  private async dispatcherFor(proxy?: string): Promise<unknown | undefined> {
    if (!proxy) return undefined;
    if (this.dispatcherCache !== undefined) return this.dispatcherCache ?? undefined;
    try {
      const undici = await import('undici');
      this.dispatcherCache = new undici.ProxyAgent(proxy);
    } catch {
      this.opts.log?.warn(`Proxy requested but undici is unavailable; continuing without proxy.`);
      this.dispatcherCache = null;
    }
    return this.dispatcherCache ?? undefined;
  }
}

function backoff(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30_000);
  }
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.random() * 300; // jitter
}

function headerMap(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}
