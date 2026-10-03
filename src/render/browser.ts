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
  'Headless rendering needs Playwright. Install it once with:\n' +
  '  npm i -D playwright && npx playwright install chromium\n' +
  'Or stay on free static tiers with --max-tier static.';

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
