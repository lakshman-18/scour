import type { PageAction } from './types.js';

/**
 * Page actions written on the command line, run in order before the page is read:
 *
 *   wait:1500          wait 1.5 s          wait:#results       until it appears
 *   click:.load-more   click it            click-all:.expand   click every match
 *   write:#q=hello     type into a field   write:hello         type where the focus is
 *   press:Enter        a key               scroll  scroll:up  scroll:#footer
 *   screenshot         screenshot:full     js:document.title   run a script, keep its result
 */
export function parseAction(spec: string): PageAction {
  const i = spec.indexOf(':');
  const verb = (i < 0 ? spec : spec.slice(0, i)).trim().toLowerCase();
  const arg = i < 0 ? '' : spec.slice(i + 1).trim();
  switch (verb) {
    case 'wait':
      return /^\d+$/.test(arg) || !arg ? { type: 'wait', milliseconds: Number(arg || 1000) } : { type: 'wait', selector: arg };
    case 'click':
    case 'click-all':
      if (!arg) throw new Error(`"${spec}": click needs a CSS selector, e.g. click:.load-more`);
      return { type: 'click', selector: arg, ...(verb === 'click-all' ? { all: true } : {}) };
    case 'write':
    case 'type': {
      const eq = arg.indexOf('=');
      // "#q=hello" types into #q; a bare "hello" types where the focus is.
      if (eq > 0 && /^[#.[\w-]/.test(arg) && !/\s/.test(arg.slice(0, eq))) return { type: 'write', selector: arg.slice(0, eq), text: arg.slice(eq + 1) };
      return { type: 'write', text: arg };
    }
    case 'press':
      return { type: 'press', key: arg || 'Enter' };
    case 'scroll':
      if (!arg || arg === 'down') return { type: 'scroll', direction: 'down' };
      if (arg === 'up') return { type: 'scroll', direction: 'up' };
      return { type: 'scroll', selector: arg };
    case 'screenshot':
      return { type: 'screenshot', fullPage: arg === 'full' };
    case 'js':
    case 'script':
      if (!arg) throw new Error(`"${spec}": js needs a script, e.g. js:document.title`);
      return { type: 'executeJavascript', script: arg };
    default:
      throw new Error(`Unknown action "${verb}". Use wait, click, click-all, write, press, scroll, screenshot or js.`);
  }
}

/** Firecrawl's action objects, checked and normalised. */
export function actionsFromFirecrawl(raw: unknown): PageAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((a: Record<string, unknown>) => {
    switch (a?.type) {
      case 'wait': return { type: 'wait', milliseconds: num(a.milliseconds), selector: str(a.selector) };
      case 'click': return { type: 'click', selector: req(a.selector, 'click.selector'), all: a.all === true };
      case 'write': return { type: 'write', text: req(a.text, 'write.text'), selector: str(a.selector) };
      case 'press': return { type: 'press', key: req(a.key, 'press.key') };
      case 'scroll': return { type: 'scroll', direction: a.direction === 'up' ? 'up' : 'down', selector: str(a.selector) };
      case 'screenshot': return { type: 'screenshot', fullPage: a.fullPage === true };
      case 'executeJavascript': return { type: 'executeJavascript', script: req(a.script, 'executeJavascript.script') };
      default: throw new Error(`Unsupported action type "${String(a?.type)}"`);
    }
  }) as PageAction[];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function req(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
  return v;
}
