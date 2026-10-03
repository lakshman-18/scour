import { Tier, TierError, type Logger, type RenderOptions, type RenderedPage } from '../core/types.js';

/**
 * Headless rendering. Playwright is an OPTIONAL dependency — scour installs in
 * seconds without it and only ~1% of URLs ever need it. We import it lazily and
 * give a precise install hint when it's missing.
 */
let browserPromise: Promise<unknown> | null = null;
// A variable specifier keeps TypeScript from requiring playwright's types at build time.
const PW = 'playwright';
let playwrightMissing = false;

export const PLAYWRIGHT_HINT =
  'Headless rendering needs a browser. Install it once (about 150 MB) with:\n' +
  '  npx playwright install chromium\n' +
  'If that says Playwright is missing: npm i -g playwright, then run it again.\n' +
  'Or stay on the free static tiers with --max-tier static.';

export async function isRenderAvailable(): Promise<boolean> {
  if (playwrightMissing) return false;
  try {
    await import(PW);
    return true;
  } catch {
    playwrightMissing = true;
    return false;
  }
}

async function getBrowser(log?: Logger): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let pw: any;
      try {
        pw = await import(PW);
      } catch {
        playwrightMissing = true;
        throw new TierError(PLAYWRIGHT_HINT, Tier.Headless, false);
      }
      log?.debug('launching headless chromium');
      return pw.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
      });
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b: any = await browserPromise;
    await b.close();
  } catch {
    // Already gone.
  }
  browserPromise = null;
}

export interface RenderDeps {
  userAgent: string;
  proxy?: string;
  log?: Logger;
  timeoutMs: number;
}

export async function renderPage(url: string, deps: RenderDeps, opts: RenderOptions = {}): Promise<RenderedPage> {
  const browser = await getBrowser(deps.log);
  const context = await browser.newContext({
    userAgent: deps.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ...(deps.proxy ? { proxy: { server: deps.proxy } } : {}),
  });

  try {
    if (opts.cookies?.length) await context.addCookies(opts.cookies.map((c) => ({ path: '/', ...c })));

    const page = await context.newPage();

    // Blocking images/fonts/media typically halves render time and bandwidth.
    // Route interception suppresses response events in Playwright, so skip
    // blocking whenever the caller wants to read what the page fetched.
    const block = new Set(opts.captureResponses ? [] : opts.blockResources ?? ['image', 'font', 'media']);
    if (block.size) {
      await page.route('**/*', (route: any) =>
        block.has(route.request().resourceType()) ? route.abort() : route.continue(),
      );
    }

    const captured: { url: string; status: number; body: string }[] = [];
    let captureDone: () => void = () => {};
    const captureWait = new Promise<void>((r) => (captureDone = r));
    if (opts.captureResponses) {
      const want = opts.captureCount ?? 1;
      page.on('response', async (res: any) => {
        if (!opts.captureResponses!.test(res.url())) return;
        try {
          const body = await res.text();
          if (!body) return;
          captured.push({ url: res.url(), status: res.status(), body });
          if (captured.length >= want) captureDone();
        } catch {
          // Response bodies can vanish on navigation; ignore.
        }
      });
    }

    const timeout = opts.timeoutMs ?? deps.timeoutMs;
    const response = await page.goto(url, {
      waitUntil: opts.waitUntil ?? 'domcontentloaded',
      timeout,
    });

    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout }).catch(() => {
        deps.log?.debug(`waitForSelector "${opts.waitForSelector}" timed out; continuing with what loaded`);
      });
    }

    for (let i = 0; i < (opts.scroll ?? 0); i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await page.waitForTimeout(600);
    }

    const evaluated = opts.evaluate ? await page.evaluate(opts.evaluate) : undefined;
    if (opts.captureResponses && captured.length < (opts.captureCount ?? 1)) {
      await Promise.race([captureWait, page.waitForTimeout(Math.min(timeout, 20_000))]);
    }
    const html = await page.content();
    const title = await page.title().catch(() => undefined);

    return { html, url: page.url(), status: response?.status() ?? 200, title, evaluated, captured };
  } finally {
    await context.close().catch(() => {});
  }
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  width?: number;
  height?: number;
  /** Emulate a phone (390×844, mobile UA, touch). */
  mobile?: boolean;
  format?: 'png' | 'jpeg';
  /** JPEG quality 1–100. */
  quality?: number;
  /** Extra settle time after load, for animations and lazy content. */
  waitMs?: number;
  /** Only capture this element. */
  selector?: string;
}

/** Render a page in headless Chromium and return an image of it. */
export async function screenshotPage(url: string, deps: RenderDeps, opts: ScreenshotOptions = {}): Promise<{ data: Buffer; mimeType: string; url: string; title?: string }> {
  const browser = await getBrowser(deps.log);
  const mobile = !!opts.mobile;
  const context = await browser.newContext({
    userAgent: mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
      : deps.userAgent,
    viewport: { width: opts.width ?? (mobile ? 390 : 1440), height: opts.height ?? (mobile ? 844 : 900) },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US',
    ...(deps.proxy ? { proxy: { server: deps.proxy } } : {}),
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: deps.timeoutMs });
    await page.waitForTimeout(opts.waitMs ?? 800);
    const format = opts.format ?? 'png';
    const shotOpts = { type: format, ...(format === 'jpeg' ? { quality: opts.quality ?? 75 } : {}) };
    const data: Buffer = opts.selector
      ? await page.locator(opts.selector).first().screenshot(shotOpts)
      : await page.screenshot({ ...shotOpts, fullPage: !!opts.fullPage });
    return { data, mimeType: `image/${format}`, url: page.url(), title: await page.title().catch(() => undefined) };
  } finally {
    await context.close().catch(() => {});
  }
}
