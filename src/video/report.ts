import { fmt } from './media.js';
import { describe, pictures, type Action, type Picture, type Watched } from './watch.js';

/**
 * A watched recording, written up for a person (or an agent) who hasn't seen it:
 * what happened step by step with how each step is known, the flow between
 * screens, what is on each screen, how long things took, and the steps to do
 * it again. Plus the evidence pictures.
 */
export async function renderWatched(w: Watched, maxImages = 8): Promise<{ markdown: string; images: Picture[] }> {
  const md: string[] = [];
  const steps = w.actions;
  const clicks = steps.filter((a) => a.kind === 'click').length;
  const typed = steps.filter((a) => a.kind === 'type').length;
  const scrolls = steps.filter((a) => a.kind === 'scroll').length;
  const errors = steps.filter((a) => a.result.kind === 'error');
  const titles = w.screens.map((s) => s.title);

  md.push(`# What happens in this recording`);
  md.push('');
  md.push(`${fmt(w.duration)} long, ${w.width}×${w.height}${w.portrait ? ' (portrait: a phone)' : ''}. ${w.screens.length} screen${w.screens.length === 1 ? '' : 's'}: ${titles.map((t) => `"${t}"`).join(' → ')}.`);
  md.push(`${steps.length} steps: ${clicks} click${clicks === 1 ? '' : 's'}, ${typed} typing, ${scrolls} scroll${scrolls === 1 ? '' : 's'}${errors.length ? `; ${errors.length} error${errors.length === 1 ? '' : 's'} shown` : ''}.`);
  md.push('');
  md.push(`How each step is known: **seen** means the pointer was found on it as the screen changed; **read** means the text on screen changed; **inferred** means the result was seen but the pointer did not move, so the click is deduced from what was under it.`);
  if (!w.pointerSeen) md.push(`No pointer is visible in this recording (a phone, or a hidden cursor), so taps are deduced from what changed.`);
  md.push('');

  md.push(`## Steps`);
  md.push('');
  md.push(`| # | Time | Step | Known by | Took |`);
  md.push(`|---|------|------|----------|------|`);
  for (const a of steps) {
    const took = [a.responseSec !== undefined ? `${a.responseSec.toFixed(1)} s` : '', a.loadingSec ? `loading ${a.loadingSec.toFixed(1)} s` : ''].filter(Boolean).join(', ');
    md.push(`| ${a.n} | ${fmt(a.t)} | ${cell(describe(a))}${a.said ? ` — *said:* "${cell(a.said)}"` : ''} | ${a.evidence} | ${took} |`);
  }
  md.push('');

  // Flow between screens.
  const edges: string[] = [];
  for (const a of steps) {
    const from = w.states[a.from]?.screen, to = w.states[a.to]?.screen;
    if (!from || !to || from <= 0 || to <= 0) continue;
    const label = a.kind === 'click' ? (a.target?.text ?? 'click') : a.kind;
    if (from !== to) edges.push(`  S${from} -->|"${mer(label)}"| S${to}`);
    else if (a.result.kind === 'dialog-open' || a.result.kind === 'error' || a.result.kind === 'toast') edges.push(`  S${from} -.->|"${mer(label)} → ${{ 'dialog-open': 'dialog', error: 'error', toast: 'notice' }[a.result.kind]}"| S${from}`);
  }
  if (edges.length) {
    md.push(`## Flow`);
    md.push('');
    md.push('```mermaid');
    md.push('flowchart LR');
    for (const s of w.screens) md.push(`  S${s.id}["${mer(s.title)}"]`);
    md.push(...[...new Set(edges)]);
    md.push('```');
    md.push('');
  }

  md.push(`## Screens`);
  md.push('');
  for (const s of w.screens) {
    md.push(`### ${s.id}. ${s.title}`);
    md.push(`First seen at ${fmt(s.firstSeen)}${s.visits > 1 ? `, visited ${s.visits} times` : ''}.`);
    const by = (k: string) => [...new Set(s.els.filter((e) => e.kind === k).map((e) => e.text))];
    // Fields by their label (the placeholder), not by what was typed into them.
    const typedText = new Set(steps.map((a) => a.typed).filter(Boolean));
    const fields = [...new Set(s.els.filter((e) => e.kind === 'input' && !typedText.has(e.text)).map((e) => e.text))];
    const parts: [string, string[]][] = [['Buttons', by('button')], ['Inputs', fields.length ? fields : by('input')], ['Tabs', by('tab')], ['Values', by('value')], ['Errors', by('error')]];
    for (const [name, list] of parts) if (list.length) md.push(`- ${name}: ${list.map((x) => `"${x}"`).join(', ')}`);
    if (s.variants.length) md.push(`- Also seen with: ${s.variants.map((x) => (/^".*"$/.test(x) ? x : `"${x}"`)).join(', ')}`);
    md.push('');
  }

  const slow = steps.filter((a) => (a.loadingSec ?? 0) >= 1 || (a.responseSec ?? 0) >= 2);
  if (slow.length) {
    md.push(`## Waits`);
    md.push('');
    for (const a of slow) md.push(`- Step ${a.n} (${fmt(a.t)}): ${a.loadingSec ? `loading ${a.loadingSec.toFixed(1)} s` : `${a.responseSec!.toFixed(1)} s to settle`} after ${describe(a).split(' → ')[0]}`);
    md.push('');
  }

  md.push(`## To do it again`);
  md.push('');
  let k = 0;
  for (const a of steps) {
    const line = redo(a);
    if (line) md.push(`${++k}. ${line}`);
  }
  md.push('');

  if (w.notes.length) {
    md.push(`## Notes`);
    md.push('');
    for (const n of w.notes) md.push(`- ${n}`);
    md.push('');
  }

  const images = await pictures(w, maxImages).catch(() => []);
  return { markdown: md.join('\n'), images };
}

/** One step as an instruction a person can follow. */
function redo(a: Action): string | undefined {
  const t = a.target?.text;
  switch (a.kind) {
    case 'click': {
      const what = t ? (a.target?.kind === 'control' ? t : `"${t}"`) : `the point (${a.pointer?.x}, ${a.pointer?.y})`;
      const expect = a.result.kind === 'none' ? '' : `; it ${a.result.text}`;
      return `${a.target?.kind === 'input' ? 'Click into' : 'Click'} ${what}${expect}.`;
    }
    case 'type': return a.typed ? `Type "${a.typed}" into "${t}".` : `Type the ${/pass/i.test(t ?? '') ? 'password' : 'value'} into "${t}" (hidden in the recording).`;
    case 'scroll': return a.scrollPx ? `Scroll ${a.scrollPx > 0 ? 'down' : 'up'} about ${Math.abs(a.scrollPx)} px.` : undefined;
    default: return a.result.text ? `Wait: it ${a.result.text}.` : undefined;
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mer = (s: string) => { const t = s.replace(/["\[\]{}|<>]/g, "'"); return t.length > 48 ? `${t.slice(0, 47)}…` : t; };
