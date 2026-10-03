import type { InsightsReport, TopicStanding } from './analyze.js';

const n = (x: number): string => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`);
const oneLine = (s: string, max = 110): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Markdown report. Readable in a terminal, an AI's context, or a notes app. */
export function renderInsights(r: InsightsReport): string {
  const out: string[] = [];
  out.push(`# What's working: ${r.topic}`, '');
  out.push(
    `_${r.sample.posts} posts from ${r.sample.sources.join(', ')}` +
      (r.sample.from ? ` · ${r.sample.from.slice(0, 10)} → ${r.sample.to?.slice(0, 10)}` : '') +
      ` · traction measured as ${r.sample.metric} · typical post ${n(r.overall.median)}_`,
    '',
  );

  out.push('## Key findings', '');
  if (r.findings.length) out.push(...r.findings.map((f) => `- ${f}`));
  else out.push('- No strong pattern yet (needs more posts, or every format performs similarly).');
  out.push('');

  out.push('## Which kinds of posts get traction', '');
  // A trait is only worth showing when at least one group has enough posts.
  const judged = r.dimensions.filter((d) => d.buckets.some((b) => b.confidence !== 'low'));
  const tooFew = r.dimensions.filter((d) => !judged.includes(d)).map((d) => d.label.toLowerCase());
  for (const d of judged) {
    out.push(`**${d.label}**`);
    for (const b of d.buckets) {
      const bar = '█'.repeat(Math.max(1, Math.min(20, Math.round(b.lift * 5))));
      out.push(`- ${b.value.padEnd(22)} ${bar} ${b.lift.toFixed(1)}× · ${b.n} posts${b.confidence === 'low' ? ' · low confidence' : ''}`);
    }
    out.push('');
  }
  if (tooFew.length) out.push(`_Too few posts to judge yet: ${tooFew.join(', ')}._`, '');

  if (r.rising.length) {
    out.push('## Rising right now', '');
    for (const p of r.rising) out.push(`- **+${n(p.perHour)} likes/hour** · @${p.author?.handle ?? '?'} — ${oneLine(p.text)}\n  ${p.url}`);
    out.push('');
  }

  out.push('## Top posts', '');
  for (const p of r.topPosts) {
    out.push(`- **${n(p.score)}** · @${p.author?.handle ?? '?'} · ${p.features.format}, ${p.features.hook} — ${oneLine(p.text)}\n  ${p.url}`);
  }
  out.push('');

  if (r.phrases.length) {
    out.push('## Words that show up in the best posts', '');
    out.push(r.phrases.map((x) => `\`${x.phrase}\` (${x.lift.toFixed(1)}×)`).join(' · '), '');
  }
  if (r.authors.length) {
    out.push('## Who drives the conversation', '');
    for (const a of r.authors.slice(0, 6)) out.push(`- @${a.handle}: ${a.posts} post${a.posts > 1 ? 's' : ''}, ${n(a.total)} total, best ${n(a.best)}`);
    out.push('');
  }
  if (r.daily.length > 1) {
    out.push('## Activity by day', '');
    const max = Math.max(...r.daily.map((d) => d.posts));
    for (const d of r.daily) out.push(`- ${d.day} ${'▇'.repeat(Math.max(1, Math.round((d.posts / max) * 16)))} ${d.posts} posts, ${n(d.traction)} traction`);
    out.push('');
  }
  if (r.sample.caveats.length) out.push('## Read with care', '', ...r.sample.caveats.map((c) => `- ${c}`), '');
  return out.join('\n').trim();
}

export function renderComparison(rows: TopicStanding[], windowDays = 7): string {
  const hasMomentum = rows.some((r) => r.momentum > 0);
  const out = [
    '# Which topic is winning',
    '',
    `_Last ${windowDays} days, ranked by ${hasMomentum ? 'momentum (likes gained per hour across tracked posts)' : 'total traction (momentum appears after a second check, 30+ min later)'}_`,
    '',
    `| # | Topic | Posts (${windowDays}d) | New 24h | Typical post | Traction (${windowDays}d) | Momentum |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${r.topic} | ${r.posts}${r.tracked && r.tracked !== r.posts ? ` of ${r.tracked}` : ''} | ${r.newLast24h} | ${n(r.median)} | ${n(r.total)} | ${r.momentum > 0 ? `+${n(r.momentum)}/h` : '—'} |`),
    '',
    ...rows.filter((r) => r.best).map((r) => `- **${r.topic}** best post (${n(r.best!.score)}): ${oneLine(r.best!.text, 120)}\n  ${r.best!.url}`),
  ];
  return out.join('\n');
}
