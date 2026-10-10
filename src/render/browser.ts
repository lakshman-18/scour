import { Tier, TierError, type Logger, type PageAction, type RenderOptions, type RenderedPage } from '../core/types.js';

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

async function loadPlaywright(): Promise<any> {
  try {
    return await import(PW);
  } catch {
    playwrightMissing = true;
    throw new TierError(PLAYWRIGHT_HINT, Tier.Headless, false);
  }
}

async function getBrowser(log?: Logger): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const pw = await loadPlaywright();
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
  // A saved login (scour login) renders in its own browser profile, one use
  // at a time; everything else shares one throwaway headless browser.
  if (opts.session) {
    const session = opts.session;
    return withLock(session.dir, async () => {
      const pw = await loadPlaywright();
      deps.log?.debug(`rendering ${url} with the saved ${session.key} session`);
      let context: any;
      try {
        context = await pw.chromium.launchPersistentContext(session.dir, {
          headless: true,
          ...(session.channel ? { channel: session.channel } : {}),
          viewport: { width: 1440, height: 900 },
          ...(deps.proxy ? { proxy: { server: deps.proxy } } : {}),
        });
      } catch (err) {
        const msg = (err as Error).message;
        throw new TierError(
          /lock|in use|already running/i.test(msg)
            ? `The saved ${session.key} session is open in another scour process; try again when it finishes.`
            : `Could not open the saved ${session.key} session: ${msg.split('\n')[0]}`,
          Tier.Headless,
        );
      }
      try {
        return await drive(context, url, deps, opts);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }
  const browser = await getBrowser(deps.log);
  const context = await browser.newContext({
    userAgent: deps.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ...(deps.proxy ? { proxy: { server: deps.proxy } } : {}),
  });
  try {
    return await drive(context, url, deps, opts);
  } finally {
    await context.close().catch(() => {});
  }
}

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  return run.finally(() => {
    if (locks.get(key) === run) locks.delete(key);
  });
}

async function drive(context: any, url: string, deps: RenderDeps, opts: RenderOptions): Promise<RenderedPage> {
  if (opts.cookies?.length) await context.addCookies(opts.cookies.map((c) => ({ path: '/', ...c })));

  const page = await context.newPage();

  // Blocking images/fonts/media typically halves render time and bandwidth.
  // Route interception suppresses response events in Playwright, so skip
  // blocking whenever the caller wants to read what the page fetched.
  const wantsPixels = opts.actions?.some((a) => a.type === 'screenshot');
  const block = new Set(opts.captureResponses || wantsPixels ? [] : opts.blockResources ?? ['image', 'font', 'media']);
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

  const actionResults = opts.actions?.length ? await runActions(page, opts.actions, timeout) : undefined;

  if (opts.captureResponses && captured.length < (opts.captureCount ?? 1)) {
    await Promise.race([captureWait, page.waitForTimeout(Math.min(timeout, 20_000))]);
  }
  for (let i = 0; i < (opts.scroll ?? 0); i++) {
    const before = captured.length;
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(opts.captureResponses ? 1500 : 600);
    // Infinite lists: stop once scrolling no longer brings anything new.
    if (opts.captureResponses && captured.length === before && i > 0) break;
  }

  const evaluated = opts.evaluate ? await page.evaluate(opts.evaluate) : undefined;
  const html = await page.content();
  const title = await page.title().catch(() => undefined);

  return { html, url: page.url(), status: response?.status() ?? 200, title, evaluated, captured, actions: actionResults };
}

/**
 * Firecrawl-style page actions, in order: wait, click, write, press, scroll,
 * screenshot, executeJavascript. Each step is bounded by the page timeout.
 */
async function runActions(page: any, actions: PageAction[], timeout: number): Promise<NonNullable<RenderedPage['actions']>> {
  const out: NonNullable<RenderedPage['actions']> = { screenshots: [], javascriptReturns: [] };
  const step = Math.min(timeout, 30_000);
  for (const a of actions) {
    switch (a.type) {
      case 'wait':
        if (a.selector) await page.waitForSelector(a.selector, { timeout: step });
        else await page.waitForTimeout(Math.min(a.milliseconds ?? 1000, 30_000));
        break;
      case 'click':
        if (a.all) {
          for (const el of await page.locator(a.selector).all()) await el.click({ timeout: step }).catch(() => {});
        } else {
          await page.locator(a.selector).first().click({ timeout: step });
        }
        await page.waitForLoadState('domcontentloaded', { timeout: step }).catch(() => {});
        break;
      case 'write':
        if (a.selector) await page.locator(a.selector).first().fill(a.text, { timeout: step });
        else await page.keyboard.type(a.text, { delay: 15 });
        break;
      case 'press':
        await page.keyboard.press(a.key);
        await page.waitForLoadState('domcontentloaded', { timeout: step }).catch(() => {});
        break;
      case 'scroll': {
        if (a.selector) await page.locator(a.selector).first().scrollIntoViewIfNeeded({ timeout: step });
        else await page.mouse.wheel(0, (a.direction === 'up' ? -1 : 1) * (a.amount ?? 900));
        await page.waitForTimeout(500);
        break;
      }
      case 'screenshot': {
        const buf: Buffer = await page.screenshot({ fullPage: !!a.fullPage, type: 'png' });
        out.screenshots.push(`data:image/png;base64,${buf.toString('base64')}`);
        break;
      }
      case 'executeJavascript':
        out.javascriptReturns.push({ type: 'value', value: await page.evaluate(a.script) });
        break;
      default:
        throw new TierError(`Unknown page action "${(a as { type: string }).type}"`, Tier.Headless, false);
    }
  }
  return out;
}

/**
 * `scour login`: open a visible browser on the site's login page and keep the
 * profile once the person has signed in. scour never sees the password; it
 * only waits for the site's logged-in cookie (or for the window to close).
 */
export async function loginInteractive(
  dir: string,
  loginUrl: string,
  opts: { hosts: RegExp; loggedInCookie?: string; timeoutMs?: number; log?: Logger },
): Promise<{ loggedIn: boolean; channel?: 'chrome' }> {
  const pw = await loadPlaywright();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Prefer the installed Google Chrome: sites trust it more than a test
  // Chromium, and the same browser is then used for every later read.
  let channel: 'chrome' | undefined = 'chrome';
  let context: any;
  try {
    context = await pw.chromium.launchPersistentContext(dir, { headless: false, channel, viewport: null });
  } catch {
    channel = undefined;
    context = await pw.chromium.launchPersistentContext(dir, { headless: false, viewport: null });
  }
  let closed = false;
  context.on('close', () => (closed = true));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

  const onSite = (c: { domain: string }) => opts.hosts.test(c.domain.replace(/^\./, ''));
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let loggedIn = false;
  let siteCookies = 0;
  while (!closed && Date.now() < deadline) {
    const cookies: { name: string; domain: string }[] = await context.cookies().catch(() => []);
    siteCookies = cookies.filter(onSite).length;
    if (opts.loggedInCookie && cookies.some((c) => c.name === opts.loggedInCookie && onSite(c))) {
      loggedIn = true;
      await new Promise((r) => setTimeout(r, 4000)); // let the site finish setting up the session
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Sites we don't know the login cookie for: trust the person, who closes
  // the window when done, as long as the site set some cookies.
  if (!opts.loggedInCookie) loggedIn = siteCookies > 0;
  await context.close().catch(() => {});
  return { loggedIn, channel };
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
