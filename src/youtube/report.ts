import type { Scour } from '../core/pipeline.js';
import { fmtTime } from '../adapters/video.js';
import {
  analyzeRetention, audit, checkChapters, editDecisionList, findShorts, keywords, lintTitle, loadTimeline, outliers, scoreHook,
  suggestChapters, triageComments, type Pile,
} from './creator.js';

/**
 * The creator tools as Markdown reports: the same text in the terminal and
 * for Claude. Each ends with what an AI should write from it, because scour
 * measures and the model writes.
 */
export type CreatorAction = 'hook' | 'title' | 'chapters' | 'edit' | 'shorts' | 'comments' | 'outliers' | 'keywords' | 'retention' | 'audit';

export interface CreatorArgs {
  action: CreatorAction;
  /** A video URL or file (chapters, edit, shorts, comments, retention), channel URL (audit), topic (outliers, keywords), or a line (hook, title). */
  input: string;
  thumbnail?: string;
  /** chapters: check this chapter list instead of proposing one. */
  check?: string;
  /** retention: the Studio CSV's contents. */
  csv?: string;
  n?: number;
  deep?: boolean;
}

const h = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const link = (url: string, sec: number) => (/^https?:/.test(url) ? `[${fmtTime(sec)}](${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(sec)}s)` : fmtTime(sec));

export async function creatorReport(scour: Scour, a: CreatorArgs): Promise<{ markdown: string; data: unknown }> {
  switch (a.action) {
    case 'hook': {
      const lines = a.input.split('\n').map((l) => l.trim()).filter(Boolean);
      const scored = lines.map(scoreHook).sort((x, y) => y.score - x.score);
      const md = scored.map((s) => [`### ${s.score}/5 · "${s.line}"`, ...s.checks.map((c) => `- ${c.pass ? '✓' : '✗'} **${c.name}**: ${c.why}`)].join('\n')).join('\n\n');
      return { data: scored, markdown: `## Hook scores\n\n${md}\n\n_Write: rewrite any hook under 4/5 to pass the failed checks, keeping its idea._` };
    }
    case 'title': {
      const r = lintTitle(a.input, a.thumbnail);
      const md = [
        `## Title check`, '', `**Title:** ${r.title}`, ...(r.thumbnail ? [`**Thumbnail text:** ${r.thumbnail}`] : []), `**On a phone:** ${r.mobileView}`, '',
        r.issues.length ? r.issues.map((i) => `- ${i.severity === 'fix' ? '**Fix:**' : 'Consider:'} ${i.message}`).join('\n') : '- No problems found.',
        '', '_Write: three alternative title + thumbnail pairings that fix these, the thumbnail adding what the title leaves out._',
      ];
      return { data: r, markdown: md.join('\n') };
    }
    case 'chapters': {
      const { doc, t } = await loadTimeline(scour, a.input);
      if (a.check) {
        const r = checkChapters(a.check, t.duration);
        return {
          data: r,
          markdown: `## Chapter check: ${doc.title}\n\n${r.problems.length ? r.problems.map((p) => `- ✗ ${p}`).join('\n') : '- ✓ YouTube will show these chapters.'}`,
        };
      }
      const existing = t.chapters.length ? `_This video already has ${t.chapters.length} chapters; these are proposed from the transcript for comparison._\n\n` : '';
      const ch = suggestChapters(t.segments, t.duration, a.n);
      const check = checkChapters(ch.map((c) => `${fmtTime(c.start)} ${c.title}`).join('\n'), t.duration);
      const md = [
        `## Proposed chapters: ${doc.title}`, '', existing,
        '```', ...ch.map((c) => `${fmtTime(c.start)} ${c.title}`), '```', '',
        check.problems.length ? check.problems.map((p) => `- ✗ ${p}`).join('\n') : '- ✓ Valid for YouTube (starts at 0:00, at least 3, each 10 s or longer).',
        '', `_Labels are each section's most distinctive words. Write: a short title for each chapter from the transcript at that time; keep the timestamps._`,
      ];
      return { data: { chapters: ch, problems: check.problems }, markdown: md.join('\n') };
    }
    case 'edit': {
      const { doc, t } = await loadTimeline(scour, a.input);
      const r = editDecisionList(t.segments);
      const counts = ['dead air', 'filler', 'retake'].map((k) => `${r.cues.filter((c) => c.kind === k).length} ${k}`).join(' · ');
      const md = [
        `## Edit decision list: ${doc.title}`, '', `${counts} · ${r.fillerCount} filler words · ${r.deadAirSec} s of dead air`, '',
        '| In | Out | Cut | Why |', '| --- | --- | --- | --- |',
        ...r.cues.slice(0, 200).map((c) => `| ${fmtTime(c.at)} | ${fmtTime(c.end)} | ${c.kind} | ${c.note.replace(/\|/g, '/')} |`),
        '', /^https?:/.test(a.input) ? '_From captions: gaps are approximate. Run it on your raw recording file for exact cuts._' : '',
      ];
      return { data: r, markdown: md.join('\n') };
    }
    case 'shorts': {
      const { doc, t } = await loadTimeline(scour, a.input);
      const clips = findShorts(t, /^https?:/.test(a.input) ? doc.url : a.input, a.n ?? 5);
      const md = [
        `## Shorts inside: ${doc.title}`, '',
        ...clips.map((c, i) => [
          `### ${i + 1}. ${link(doc.url, c.start)}–${fmtTime(c.end)} (${Math.round(c.end - c.start)} s)`,
          `> ${c.firstLine}`, '', c.why.map((w) => `- ${w}`).join('\n'), '', `<details><summary>Transcript</summary>\n\n${c.text}\n\n</details>`, '', '```bash', c.cut, '```',
        ].join('\n')),
        '', '_Write: for each clip, a new first line (a hook that works without the long video), an on-screen title, and a caption._',
      ];
      return { data: clips, markdown: md.join('\n') };
    }
    case 'comments': {
      const { doc, t } = await loadTimeline(scour, a.input, a.n ?? 100);
      const r = triageComments(t.comments);
      const order: Pile[] = ['question', 'request', 'criticism', 'praise', 'spam', 'other'];
      const md = [
        `## Comments: ${doc.title}`, '', `${t.comments.length} comments read (top by likes) · ${order.map((k) => `${r.piles[k].length} ${k}`).join(' · ')}`, '',
        ...(r.pin ? [`**Pin:** "${r.pin.text.slice(0, 200)}" (${r.pin.author}, ${h(r.pin.likes ?? 0)} likes) — ${r.why}`, ''] : []),
        ...order.filter((k) => k !== 'other' && r.piles[k].length).map((k) => [
          `### ${k[0]!.toUpperCase()}${k.slice(1)}s (${r.piles[k].length})`,
          ...r.piles[k].slice(0, 8).map((c) => `- ${c.text.replace(/\s+/g, ' ').slice(0, 220)} _(${c.author}, ${h(c.likes ?? 0)} likes)_`),
        ].join('\n')),
        '', '_Write: replies to the questions and the strongest criticism in the creator\'s voice; turn the requests into video ideas._',
      ];
      return { data: r, markdown: md.join('\n\n').replace(/\n\n\n+/g, '\n\n') };
    }
    case 'outliers': {
      const r = await outliers(scour, a.input, { min: 0 });
      const md = [
        `## What is working: "${a.input}"`, '', '_Each video against its own channel\'s median views: a small channel\'s 5× beats a big channel\'s ordinary upload._', '',
        '| × own median | Views | Channel | Video |', '| --- | --- | --- | --- |',
        ...r.rows.slice(0, a.n ?? 20).map((o) => `| **${o.multiple}×** | ${h(o.views)} | ${o.channel} (median ${h(o.channelMedian)}) | [${o.title.replace(/\|/g, '/')}](${o.url}) |`),
        ...(r.skipped.length ? ['', `_Skipped: ${r.skipped.join('; ')}_`] : []),
        '', '_Write: what the top outliers have in common (angle, title shape, format) and three video ideas that use it._',
      ];
      return { data: r, markdown: md.join('\n') };
    }
    case 'keywords': {
      const r = await keywords(scour, a.input, { deep: a.deep });
      const all = [...new Set(r.flatMap((x) => x.suggestions))];
      const md = [`## What people search for: "${a.input}"`, '', ...r.map((x) => `**${x.query}…** ${x.suggestions.join(' · ')}`), '', `_${all.length} distinct searches from YouTube's own autocomplete. Write: the three searches this video should win, a description that answers them, and the tags worth having._`];
      return { data: r, markdown: md.join('\n\n') };
    }
    case 'retention': {
      if (!a.csv) throw new Error('retention needs the CSV exported from YouTube Studio (Analytics → Engagement → Audience retention → export)');
      const timed = a.input ? await loadTimeline(scour, a.input).catch(() => null) : null;
      const r = analyzeRetention(a.csv, timed?.t.duration, timed?.t.segments);
      const md = [
        `## Retention${timed ? `: ${timed.doc.title}` : ''}`, '', `- ${r.hookLeak?.message}`, ...(r.slide ? [`- ${r.slide}`] : []), `- ${r.endRetention}% are still watching at the end`, '',
        r.cliffs.length ? '### Cliffs (where the most people left)' : '', ...r.cliffs.map((c) => `- ${timed ? link(timed.doc.url, c.at) : fmtTime(c.at)}: −${c.drop}%${c.said ? ` — "${c.said}"` : ''}`),
        '', '_Write: the one change to the hook and to each cliff that would most keep viewers, quoting what was said there._',
      ];
      return { data: r, markdown: md.join('\n') };
    }
    case 'audit': {
      const r = await audit(a.input);
      const md = [
        `## Channel audit: ${r.channel ?? a.input}`, '', `${r.videos} recent videos · median ${h(r.median)} views${r.followers ? ` · ${h(r.followers)} subscribers` : ''}`, '',
        '### Hits (2× the median or more)', ...(r.hits.length ? r.hits.map((v) => `- **${v.multiple}×** ${v.title} (${h(v.views)})`) : ['- none in the recent videos']),
        '', '### Misses (half the median or less)', ...(r.misses.length ? r.misses.map((v) => `- **${v.multiple}×** ${v.title} (${h(v.views)})`) : ['- none']),
        '', '### Title and format patterns', '| Trait | Median with | Median without | Lift | Videos |', '| --- | --- | --- | --- | --- |',
        ...r.patterns.map((p) => `| ${p.trait} | ${h(p.withIt)} | ${h(p.without)} | ${p.lift}× | ${p.n} |`),
        '', '_Write: the ONE change that would most lift this channel, based on the hits, misses and patterns above._',
      ];
      return { data: r, markdown: md.join('\n') };
    }
  }
}
