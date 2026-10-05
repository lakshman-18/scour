// scour web app. Vanilla JS, no build step. Every untrusted string is inserted
// as text; scraped Markdown is rendered with marked and sanitised with
// DOMPurify before it touches the DOM. The page's CSP forbids inline scripts.

const $main = document.getElementById('main');
const $tooltip = document.getElementById('tooltip');
const $toast = document.getElementById('toast');

const SOURCES = [
  ['twitter', 'X'], ['reddit', 'Reddit'], ['hn', 'Hacker News'], ['youtube', 'YouTube'], ['github', 'GitHub'],
  ['websearch', 'Web'], ['bluesky', 'Bluesky'], ['arxiv', 'arXiv'], ['stackoverflow', 'Stack Overflow'],
  ['wikipedia', 'Wikipedia'], ['npm', 'npm'],
];

// ------------------------------------------------------------------ helpers

/** Create an element. Strings become text nodes; never HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'href') el.href = safeHref(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function safeHref(u) {
  if (typeof u === 'string' && u.startsWith('#')) return u;
  try {
    const url = new URL(u, location.href);
    return /^https?:$/.test(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
}

function ext(href, text) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Render untrusted Markdown safely. */
function md(text) {
  const div = h('div', { class: 'prose' });
  const html = window.marked.parse(String(text ?? ''), { gfm: true, breaks: false });
  div.innerHTML = window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
  for (const a of div.querySelectorAll('a[href]')) {
    a.href = safeHref(a.getAttribute('href'));
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const img of div.querySelectorAll('img')) { img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; }
  return div;
}

async function api(path, body, method) {
  const res = await fetch(path, body !== undefined
    ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const n = (x) => {
  x = Number(x || 0);
  return x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`;
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const label = (id) => SOURCES.find(([k]) => k === id)?.[1] ?? id;

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), Math.max(2600, msg.length * 55));
}

function busy(btn, text) {
  const old = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner' }), text);
  return () => { btn.disabled = false; btn.replaceChildren(...old); };
}

function errorCard(err) {
  return h('div', { class: 'card' }, h('strong', { text: 'Something went wrong' }), h('p', { class: 'muted', text: err.message || String(err) }));
}

function copy(text, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast(what), () => toast('Copy failed'));
}

function download(name, text) {
  const a = h('a', { download: name });
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'scour';
}

/** Toggle chips for picking sources. */
function sourceChips(selected, { all = true } = {}) {
  const set = new Set(selected);
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': 'Sources' });
  const render = () => {
    wrap.replaceChildren(
      ...(all ? [h('button', { type: 'button', class: 'chip', 'aria-pressed': String(set.size === 0), onclick: () => { set.clear(); render(); } }, 'All')] : []),
      ...SOURCES.map(([id, name]) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(set.has(id)),
        onclick: () => { set.has(id) ? set.delete(id) : set.add(id); if (!all && !set.size) set.add(id); render(); },
      }, name)),
    );
  };
  render();
  return { el: wrap, value: () => [...set].join(',') };
}

// ------------------------------------------------------------------ tooltip

function tip(target, build) {
  const show = (x, y) => {
    $tooltip.replaceChildren(...build());
    $tooltip.hidden = false;
    const r = $tooltip.getBoundingClientRect();
    $tooltip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12))}px`;
    $tooltip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  target.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  target.addEventListener('focus', () => { const r = target.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
  for (const ev of ['pointerleave', 'blur']) target.addEventListener(ev, () => ($tooltip.hidden = true));
}

// ------------------------------------------------------------------ charts

/**
 * Horizontal bars of "×typical" with a dashed reference line at 1×.
 * One series, one hue; values labelled at the bar tip in text colour.
 */
function liftChart(title, buckets) {
  const max = Math.max(1.25, ...buckets.map((b) => b.lift)) * 1.08;
  const grid = h('div', { class: 'hbar', role: 'list' });
  for (const b of buckets) {
    const pct = (Math.max(b.lift, 0) / max) * 100;
    const fill = h('div', { class: `fill${b.confidence === 'low' ? ' low' : ''}` });
    fill.style.width = `${pct}%`;
    const value = h('div', { class: 'value', text: `${b.lift.toFixed(1)}× · ${b.n} post${b.n === 1 ? '' : 's'}${b.confidence === 'low' ? ' (few)' : ''}` });
    placeLabel(value, pct);
    const ref = h('div', { class: 'ref' });
    ref.style.left = `${(1 / max) * 100}%`;
    const hit = h('div', { class: 'hit', tabindex: '0', role: 'listitem', 'aria-label': `${b.value}: ${b.lift.toFixed(1)} times typical traction, ${b.n} posts` });
    tip(hit, () => [h('strong', { text: `${b.lift.toFixed(1)}× typical` }), `${b.value} · median ${n(b.median)} · ${b.n} post${b.n === 1 ? '' : 's'}`]);
    grid.append(h('div', { class: 'label', text: b.value, title: b.value }), h('div', { class: 'track' }, fill, ref, value, hit));
  }
  return h('div', { class: 'chart' }, h('p', { class: 'chart-title', text: title }), grid);
}

/** Value label at the bar tip, or inside the bar's end when there's no room outside. */
function placeLabel(el, pct) {
  if (pct > 62) {
    el.classList.add('inside');
    el.style.right = `${100 - pct}%`;
  } else {
    el.style.left = `${pct}%`;
  }
}

/** Simple value bars (e.g. traction per topic). */
function valueChart(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value)) * 1.15;
  const grid = h('div', { class: 'hbar', role: 'list' });
  for (const r of rows) {
    const pct = (r.value / max) * 100;
    const fill = h('div', { class: 'fill' });
    fill.style.width = `${pct}%`;
    const value = h('div', { class: 'value', text: r.text });
    placeLabel(value, pct);
    const hit = h('div', { class: 'hit', tabindex: '0', role: 'listitem', 'aria-label': `${r.label}: ${r.text}` });
    tip(hit, () => [h('strong', { text: r.text }), r.label]);
    grid.append(h('div', { class: 'label', text: r.label, title: r.label }), h('div', { class: 'track' }, fill, value, hit));
  }
  return h('div', { class: 'chart' }, h('p', { class: 'chart-title', text: title }), grid);
}

/** Columns over days. */
function dailyChart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.posts));
  const cols = h('div', { class: 'cols', role: 'list' });
  for (const d of daily) {
    const col = h('div', { class: 'col', tabindex: '0', role: 'listitem', 'aria-label': `${d.day}: ${d.posts} posts` });
    col.style.height = `${(d.posts / max) * 100}%`;
    tip(col, () => [h('strong', { text: `${d.posts} post${d.posts === 1 ? '' : 's'}` }), `${day(d.day)} · ${n(d.traction)} traction`]);
    cols.append(col);
  }
  return h('div', { class: 'chart' },
    h('p', { class: 'chart-title', text: 'Posts by day' }),
    cols,
    h('div', { class: 'col-axis' }, h('span', { text: day(daily[0]?.day) }), h('span', { text: day(daily[daily.length - 1]?.day) })));
}

// ------------------------------------------------------------------ views

function viewRead(params) {
  const url = params.get('url') || '';
  const input = h('input', { type: 'url', placeholder: 'Paste any link: a tweet or X Article, Reddit thread, YouTube video, GitHub, PDF, article…', value: url, 'aria-label': 'URL', required: true });
  const comments = h('input', { type: 'checkbox', checked: params.get('comments') !== '0' });
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); location.hash = `#read?url=${encodeURIComponent(input.value.trim())}&comments=${comments.checked ? 1 : 0}`; } },
    h('div', { class: 'bar' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Read')),
    h('label', { class: 'check' }, comments, 'Include comments and replies'));
  const out = h('div');
  $main.append(h('h1', { text: 'Read anything' }), h('p', { class: 'lede', text: 'Clean text from any page, for $0. Comments, transcripts and full X Articles included.' }), form, out);
  if (!url) { input.focus(); return; }

  out.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Reading…'));
  api(`/scour/get?url=${encodeURIComponent(url)}&comments=${comments.checked}`).then((d) => {
    const p = d.provenance || {};
    const e = d.engagement || {};
    const facts = d.extra?.structured || [];
    const meta = [
      d.author && (d.author.handle ? `@${d.author.handle}` : d.author.name),
      d.publishedAt && day(d.publishedAt),
      e.score !== undefined && `${n(e.score)} ${d.source === 'twitter' ? 'likes' : 'points'}`,
      e.comments !== undefined && `${n(e.comments)} comments`,
      e.views !== undefined && `${n(e.views)} views`,
    ].filter(Boolean);
    out.replaceChildren(
      h('article', { class: 'card' },
        h('div', { class: 'doc-head' },
          h('span', { class: 'badge', text: d.source }),
          h('h1', { text: d.title || d.url }),
          h('div', { class: 'meta' }, ...meta.map((m) => h('span', { text: m }))),
          h('div', { class: 'row', style: undefined },
            h('span', { class: 'prov', text: `${p.tierName} · ${p.adapter}/${p.strategy} · ${p.elapsedMs}ms · $${(p.costUsd || 0).toFixed(4)}${p.cached ? ' · cached' : ''}` })),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', onclick: () => copy(d.text, 'Markdown copied') }, 'Copy Markdown'),
            h('button', { class: 'btn small', onclick: () => download(`${slug(d.title || d.url)}.md`, `# ${d.title || d.url}\n\n${d.url}\n\n${d.text}`) }, 'Download .md'),
            ext(d.url, 'Open original ↗'))),
        facts.length ? factsCard(facts) : null,
        md(d.text)));
  }).catch((err) => out.replaceChildren(errorCard(err)));
}

function factsCard(items) {
  return h('div', { class: 'card facts' }, h('div', { class: 'kicker', text: 'Structured data on this page' }),
    ...items.map((it) => h('div', {},
      h('h3', { text: it.type }),
      h('dl', {}, ...Object.entries(it.facts).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: Array.isArray(v) ? v.join(', ') : String(v) })])))));
}

function viewSearch(params) {
  const q = params.get('q') || '';
  const chips = sourceChips((params.get('s') || '').split(',').filter(Boolean));
  const sort = h('select', { class: 'input', 'aria-label': 'Sort' },
    ...[['relevance', 'Most relevant'], ['engagement', 'Most discussed'], ['recent', 'Newest']].map(([v, t]) => h('option', { value: v, selected: params.get('sort') === v }, t)));
  const input = h('input', { type: 'text', placeholder: 'Search Reddit, X, Hacker News, YouTube, GitHub and the web at once', value: q, 'aria-label': 'Search' });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); location.hash = `#search?q=${encodeURIComponent(input.value.trim())}&s=${chips.value()}&sort=${sort.value}`; } },
    h('div', { class: 'bar' }, input, sort, h('button', { class: 'btn primary', type: 'submit' }, 'Search')), chips.el);
  const out = h('div', { class: 'stack' });
  const tips = h('p', { class: 'tips muted' },
    h('code', { text: 'ToolMark' }), ' that spelling only · ', h('code', { text: '"exact phrase"' }), ' · ',
    h('code', { text: '-word' }), ' leave out · ', h('code', { text: 'from:handle' }), ' one X account');
  $main.append(h('h1', { text: 'Search everywhere' }), h('p', { class: 'lede', text: 'One query across platforms. Off-topic results are filtered out, and you are told what was hidden.' }), form, tips, h('div', { class: 'stack' }, out));
  if (!q) { input.focus(); return; }

  out.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Searching…'));
  const qs = new URLSearchParams({ q, limit: '10', sort: sort.value });
  if (chips.value()) qs.set('source', chips.value());
  api(`/scour/search?${qs}`).then((r) => {
    // Notes are plain text with `commands` in backticks.
    const note = (t) => h('p', {}, ...t.split('`').map((part, i) => (i % 2 ? h('code', { text: part }) : part)));
    const notes = r.notes?.length ? h('div', { class: 'notes', role: 'note' }, ...r.notes.map(note)) : null;
    if (!r.results.length) return out.replaceChildren(...[h('div', { class: 'empty', text: 'No results.' }), notes].filter(Boolean));
    out.replaceChildren(...[
      h('p', { class: 'muted', text: `${r.results.length} ${r.results.length === 1 ? 'result' : 'results'} · ${r.provenance.strategy.replace(/\+/g, ', ')} · ${r.provenance.elapsedMs}ms` }),
      notes,
      ...r.results.map(resultCard)].filter(Boolean));
  }).catch((err) => out.replaceChildren(errorCard(err)));
}

function resultCard(r) {
  const e = r.engagement || {};
  const meta = [
    label(r.source),
    r.publishedAt && day(r.publishedAt),
    r.author && (r.author.handle ? `@${r.author.handle}` : r.author.name),
    e.score !== undefined && `${n(e.score)} ${r.source === 'twitter' ? 'likes' : 'pts'}`,
    e.comments !== undefined && `${n(e.comments)} comments`,
    e.views !== undefined && `${n(e.views)} views`,
    /timeline|archive/.test(r.extra?.via || '') && (r.extra.via.includes('archive') ? 'from your archive' : 'read from the account'),
  ].filter(Boolean);
  return h('div', { class: 'card result' },
    h('div', { class: 'meta' }, ...meta.map((m, i) => (i === 0 ? h('span', { class: 'badge', text: m }) : h('span', { text: m })))),
    h('h3', {}, h('a', { href: `#read?url=${encodeURIComponent(r.url)}` }, r.title)),
    r.snippet ? h('p', { text: r.snippet.length > 300 ? `${r.snippet.slice(0, 300)}…` : r.snippet }) : null,
    h('div', { class: 'row actions' },
      h('a', { class: 'btn small', href: `#read?url=${encodeURIComponent(r.url)}` }, 'Read'),
      ext(r.url, 'Open ↗')));
}

function viewResearch(params) {
  const q = params.get('q') || '';
  const chips = sourceChips((params.get('s') || '').split(',').filter(Boolean));
  const depth = h('select', { class: 'input', 'aria-label': 'Sources to read' },
    ...[4, 6, 8, 10].map((v) => h('option', { value: v, selected: String(v) === (params.get('n') || '6') }, `Read ${v}`)));
  const input = h('input', { type: 'text', placeholder: 'Ask a question: "What are people saying about OpenAI Dots?"', value: q, 'aria-label': 'Question' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Research');
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); location.hash = `#research?q=${encodeURIComponent(input.value.trim())}&s=${chips.value()}&n=${depth.value}`; } },
    h('div', { class: 'bar' }, input, depth, btn), chips.el);
  const out = h('div', { class: 'stack' });
  $main.append(h('h1', { text: 'Research' }), h('p', { class: 'lede', text: 'Searches, reads the best results in full, and builds one cited pack you can hand to any AI.' }), form, out);
  if (!q) { input.focus(); return; }

  const done = busy(btn, 'Reading');
  out.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Searching and reading the best sources… this takes 10–40 seconds.'));
  api('/scour/research', { question: q, sources: chips.value() || undefined, limit: Number(depth.value) }).then((pack) => {
    out.replaceChildren(
      h('div', { class: 'row' },
        h('span', { class: 'muted', text: `${pack.stats.read} sources read in ${(pack.stats.elapsedMs / 1000).toFixed(1)}s · $${pack.stats.costUsd.toFixed(4)}` }),
        h('button', { class: 'btn small', onclick: () => copy(pack.markdown, 'Pack copied: paste it into any AI') }, 'Copy pack'),
        h('button', { class: 'btn small', onclick: () => download(`research-${slug(q)}.md`, pack.markdown) }, 'Download .md')),
      h('div', { class: 'card' }, md(pack.markdown)));
  }).catch((err) => out.replaceChildren(errorCard(err))).finally(done);
}

async function viewWatch() {
  const listEl = h('div', { class: 'stack' }, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Loading…'));
  const resultEl = h('div', { class: 'stack' });
  let mode = 'url';
  const target = h('input', { type: 'text', placeholder: 'Page or feed URL to watch', 'aria-label': 'What to watch' });
  const chips = sourceChips(['twitter', 'reddit', 'hn'], { all: false });
  chips.el.hidden = true;
  const segBtns = [['url', 'A page or feed'], ['topic', 'A topic']].map(([id, t]) => h('button', {
    type: 'button', 'aria-pressed': String(id === mode),
    onclick: () => {
      mode = id;
      segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === mode)));
      target.placeholder = mode === 'url' ? 'Page or feed URL to watch' : 'Topic to watch, e.g. "my product name"';
      chips.el.hidden = mode !== 'topic';
    },
    dataset: { id },
  }, t));
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Watch');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const v = target.value.trim();
    if (!v) return;
    const done = busy(addBtn, 'Baselining');
    try {
      if (mode === 'url') await api('/scour/watch', { url: v });
      else await api('/scour/watch/search', { search: v, sources: chips.value() });
      target.value = '';
      toast('Watching. Future checks report only what is new.');
      load();
    } catch (err) { toast(err.message); } finally { done(); }
  } },
  h('div', { class: 'row' }, h('div', { class: 'seg' }, ...segBtns)),
  h('div', { class: 'bar' }, target, addBtn), chips.el);

  const checkAll = h('button', { class: 'btn', onclick: async () => {
    const done = busy(checkAll, 'Checking');
    try {
      const rs = await api('/scour/watch/all', {});
      const changed = rs.filter((r) => r.changed);
      resultEl.replaceChildren(changed.length ? h('div', {}, ...changed.map(changeCard)) : h('div', { class: 'empty', text: `Checked ${rs.length} watch${rs.length === 1 ? '' : 'es'}: nothing new.` }));
      load();
    } catch (err) { resultEl.replaceChildren(errorCard(err)); } finally { done(); }
  } }, 'Check all now');

  const serviceEl = h('div');
  $main.append(
    h('div', { class: 'row' }, h('h1', { text: 'Watch' }), h('span', { class: 'muted' }), checkAll),
    h('p', { class: 'lede', text: 'Follow pages, feeds and topics. Only new items are reported, and the background service can send you one daily digest.' }),
    form, resultEl, h('h2', { text: 'Your watches' }), listEl, h('h2', { text: 'Background service' }), serviceEl);

  async function load() {
    try {
      const ws = await api('/scour/watches');
      if (!ws.length) return listEl.replaceChildren(h('div', { class: 'empty', text: 'Nothing watched yet.' }));
      listEl.replaceChildren(...ws.map((w) => {
        const out = h('div');
        const checkBtn = h('button', { class: 'btn small', onclick: async () => {
          const done = busy(checkBtn, 'Checking');
          try {
            const r = w.search ? await api('/scour/watch/search', { search: w.search.query, sources: w.search.sources }) : await api('/scour/watch', { url: w.url });
            out.replaceChildren(r.changed ? changeCard(r) : h('p', { class: 'muted', text: 'No changes since the last check.' }));
          } catch (err) { out.replaceChildren(errorCard(err)); } finally { done(); }
        } }, 'Check now');
        const rmBtn = h('button', { class: 'btn small', onclick: async () => {
          await api('/scour/watch/remove', w.search ? { search: w.search.query, sources: w.search.sources } : { url: w.url });
          toast('Stopped watching');
          load();
        } }, 'Remove');
        return h('div', { class: 'card' },
          h('div', { class: 'kicker', text: w.search ? `Topic · ${(w.search.sources || 'all').split(',').map(label).join(', ')}` : 'Page / feed' }),
          h('h3', { text: w.label || w.url }),
          w.search ? null : h('div', { class: 'meta' }, ext(w.url, w.url)),
          h('div', { class: 'meta' },
            h('span', { text: `${w.runs} checks` }), h('span', { text: `${w.items} items seen` }),
            h('span', { text: `last change ${when(w.lastChangedAt)}` }),
            h('span', { text: w.alerts.length ? `alerts: ${w.alerts.join(', ')}` : 'digest only' })),
          h('div', { class: 'row actions' }, checkBtn, rmBtn), out);
      }));
    } catch (err) { listEl.replaceChildren(errorCard(err)); }
  }
  load();

  try {
    const st = await api('/scour/status');
    const s = st.service;
    const digestBtn = h('button', { class: 'btn small' }, 'Preview digest');
    const digestOut = h('div');
    digestBtn.addEventListener('click', async () => {
      const done = busy(digestBtn, 'Building');
      try { const d = await api('/scour/digest'); digestOut.replaceChildren(h('div', { class: 'card' }, md(d.markdown))); } catch (err) { digestOut.replaceChildren(errorCard(err)); } finally { done(); }
    });
    serviceEl.replaceChildren(h('div', { class: 'card stack' },
      h('div', {}, h('span', { class: `dot ${s.loaded ? 'ready' : 'degraded'}` }), h('strong', { text: s.loaded ? 'Running in the background' : 'Not running' })),
      s.loaded
        ? h('p', { class: 'muted', text: `Checks watches every ${s.config.everyMinutes} min and topics every ${s.config.trackEveryMinutes} min. Daily digest ${s.config.digestAt || 'off'}${s.config.digestAt ? ` → ${s.config.notify.join(', ') || 'saved to file'}` : ''}. Last run ${when(s.config.lastTickAt)}.` })
        : h('p', { class: 'muted' }, 'Start it once and watches run on their own, even with this page closed: ', h('code', { class: 'cmd', text: 'scour service install' })),
      h('div', { class: 'row' }, digestBtn), digestOut));
  } catch (err) { serviceEl.replaceChildren(errorCard(err)); }
}

function changeCard(r) {
  return h('div', { class: 'card' },
    h('div', { class: 'kicker', text: r.kind === 'new-items' ? `${r.newItems.length} new` : 'Changed' }),
    h('h3', { text: r.label || r.url }),
    r.newItems.length
      ? h('ul', {}, ...r.newItems.slice(0, 15).map((it) => h('li', {}, h('a', { href: `#read?url=${encodeURIComponent(it.url)}` }, it.title || it.url))))
      : r.diff ? h('pre', { class: 'post-text', text: r.diff.slice(0, 2000) }) : null);
}

async function viewInsights(params) {
  const selected = new Set((params.get('t') || '').split('|').filter(Boolean));
  const topicsEl = h('div', { class: 'chips' });
  const out = h('div', { class: 'stack' });
  const refresh = h('input', { type: 'checkbox', checked: true });
  const analyzeBtn = h('button', { class: 'btn primary', type: 'button' }, 'Analyze');
  const newTopic = h('input', { type: 'text', placeholder: 'Track a new topic, e.g. "Claude Code"', 'aria-label': 'New topic' });
  const chips = sourceChips(['twitter'], { all: false });
  const trackBtn = h('button', { class: 'btn', type: 'submit' }, 'Track');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const t = newTopic.value.trim();
    if (!t) return;
    const done = busy(trackBtn, 'Collecting');
    try {
      const r = await api('/scour/track', { topic: t, sources: chips.value() });
      toast(`Tracking “${t}”: ${r.posts} posts collected`);
      newTopic.value = '';
      selected.clear(); selected.add(t);
      location.hash = `#insights?t=${encodeURIComponent(t)}`;
    } catch (err) { toast(err.message); } finally { done(); }
  } }, h('div', { class: 'bar' }, newTopic, trackBtn), chips.el);

  analyzeBtn.addEventListener('click', () => {
    if (!selected.size) return toast('Pick at least one topic');
    location.hash = `#insights?t=${encodeURIComponent([...selected].join('|'))}&r=${refresh.checked ? 1 : 0}`;
  });

  $main.append(
    h('h1', { text: 'Insights' }),
    h('p', { class: 'lede', text: 'What works on X for a topic: which kinds of posts get traction, what is rising, and which topic is winning. Pick one topic for patterns, or several to compare.' }),
    h('h2', { text: 'Tracked topics' }), topicsEl,
    h('div', { class: 'row actions' }, analyzeBtn, h('label', { class: 'check' }, refresh, 'Collect fresh data first (uses a little search quota)')),
    form, out);

  let topics = [];
  try {
    topics = await api('/scour/topics');
  } catch (err) { out.append(errorCard(err)); }
  const renderChips = () => topicsEl.replaceChildren(...(topics.length ? topics.map((t) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(selected.has(t.query)),
    title: `${t.posts} posts · ${t.runs} checks · last ${when(t.lastRunAt)}`,
    onclick: () => { selected.has(t.query) ? selected.delete(t.query) : selected.add(t.query); renderChips(); },
  }, `${t.query} · ${t.posts}`)) : [h('span', { class: 'muted', text: 'No tracked topics yet. Add one below.' })]));
  renderChips();

  const wanted = [...selected];
  if (!wanted.length) return;
  out.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), wanted.length > 1 ? 'Comparing topics…' : 'Analysing posts…'));
  try {
    const t0 = topics.find((t) => t.query === wanted[0]);
    const res = await api('/scour/insights', { topics: wanted, sources: t0?.sources || 'twitter', refresh: params.get('r') === '1', days: 7 });
    out.replaceChildren(res.mode === 'compare' ? compareView(res.rows, res.days) : reportView(res.report));
  } catch (err) { out.replaceChildren(errorCard(err)); }
}

function reportView(r) {
  if (!r.sample.posts) return h('div', { class: 'empty', text: 'No posts collected for this topic yet. Tick “Collect fresh data first” and analyze again.' });
  const judged = r.dimensions.filter((d) => d.buckets.some((b) => b.confidence !== 'low'));
  const tooFew = r.dimensions.filter((d) => !judged.includes(d)).map((d) => d.label.toLowerCase());
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'kicker', text: 'What’s working' }),
      h('h2', { text: r.topic }),
      h('p', { class: 'muted', text: `${r.sample.posts} posts · ${r.sample.sources.map(label).join(', ')}${r.sample.from ? ` · ${day(r.sample.from)} – ${day(r.sample.to)}` : ''} · traction = ${r.sample.metric} · typical post ${n(r.overall.median)}` }),
      h('h3', { text: 'Key findings' }),
      r.findings.length ? h('div', {}, ...r.findings.map((f) => md(`- ${f}`))) : h('p', { class: 'muted', text: 'No strong pattern yet. Patterns firm up as more posts are tracked.' })),
    h('div', { class: 'card' },
      h('h3', { text: 'Which kinds of posts get traction' }),
      h('p', { class: 'legend-note', text: 'Bars show median traction relative to a typical post; the dashed line is 1× (typical). Faded bars have few posts.' }),
      ...judged.map((d) => liftChart(d.label, d.buckets)),
      tooFew.length ? h('p', { class: 'muted', text: `Too few posts to judge yet: ${tooFew.join(', ')}.` }) : null),
    r.rising.length ? h('div', {}, h('h2', { text: 'Rising right now' }), ...r.rising.map((p) => postCard(p, `+${n(p.perHour)} likes/hour`))) : null,
    h('div', {}, h('h2', { text: 'Top posts' }), ...r.topPosts.map((p) => postCard(p, `${n(p.score)} traction`))),
    r.phrases.length ? h('div', { class: 'card' }, h('h3', { text: 'Words that show up in the best posts' }), h('div', { class: 'chips' }, ...r.phrases.map((x) => h('span', { class: 'chip', text: `${x.phrase} · ${x.lift.toFixed(1)}×` })))) : null,
    r.authors.length ? h('div', { class: 'card' }, h('h3', { text: 'Who drives the conversation' }),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Account' }), h('th', { text: 'Posts' }), h('th', { text: 'Total' }), h('th', { text: 'Best' }))),
        h('tbody', {}, ...r.authors.slice(0, 8).map((a) => h('tr', {}, h('td', {}, ext(`https://x.com/${a.handle}`, `@${a.handle}`)), h('td', { class: 'n', text: a.posts }), h('td', { class: 'n', text: n(a.total) }), h('td', { class: 'n', text: n(a.best) }))))))
      : null,
    r.daily.length > 1 ? h('div', { class: 'card' }, dailyChart(r.daily)) : null,
    r.sample.caveats.length ? h('details', { class: 'card' }, h('summary', { text: 'Read with care' }), h('ul', {}, ...r.sample.caveats.map((c) => h('li', { text: c })))) : null);
}

function postCard(p, headline) {
  const f = p.features || {};
  return h('div', { class: 'card result' },
    h('div', { class: 'meta' }, h('span', { class: 'badge', text: headline }), h('span', { text: `@${p.author?.handle ?? '?'}` }),
      p.createdAt ? h('span', { text: day(p.createdAt) }) : null,
      h('span', { text: `${n(p.metrics.likes)} likes · ${n(p.metrics.replies)} replies` }),
      h('span', { text: [f.format, f.hook].filter(Boolean).join(' · ') })),
    h('p', { class: 'post-text', text: p.text.length > 420 ? `${p.text.slice(0, 420)}…` : p.text }),
    h('div', { class: 'row actions' }, h('a', { class: 'btn small', href: `#read?url=${encodeURIComponent(p.url)}` }, 'Read'), ext(p.url, 'Open on X ↗')));
}

function compareView(rows, days) {
  const momentum = rows.some((r) => r.momentum > 0);
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'kicker', text: `Last ${days} days` }),
      h('h2', { text: 'Which topic is winning' }),
      h('p', { class: 'muted', text: momentum ? 'Ranked by momentum: likes gained per hour across tracked posts.' : 'Ranked by total traction. Momentum appears once topics have been checked twice, 30+ minutes apart.' }),
      valueChart(momentum ? 'Momentum (likes/hour)' : `Traction, last ${days} days`, rows.map((r) => ({ label: r.topic, value: momentum ? r.momentum : r.total, text: momentum ? `+${n(r.momentum)}/h` : n(r.total) }))),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ...['#', 'Topic', `Posts (${days}d)`, 'New 24h', 'Typical post', 'Traction', 'Momentum'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows.map((r, i) => h('tr', {},
          h('td', { class: 'n', text: i + 1 }), h('td', { text: r.topic }),
          h('td', { class: 'n', text: `${r.posts}${r.tracked && r.tracked !== r.posts ? ` of ${r.tracked}` : ''}` }),
          h('td', { class: 'n', text: r.newLast24h }), h('td', { class: 'n', text: n(r.median) }),
          h('td', { class: 'n', text: n(r.total) }), h('td', { class: 'n', text: r.momentum > 0 ? `+${n(r.momentum)}/h` : '—' })))))),
    h('h2', { text: 'Best post per topic' }),
    ...rows.filter((r) => r.best).map((r) => h('div', { class: 'card result' },
      h('div', { class: 'meta' }, h('span', { class: 'badge', text: r.topic }), h('span', { text: `${n(r.best.score)} traction` })),
      h('p', { class: 'post-text', text: r.best.text }),
      h('div', { class: 'row actions' }, h('a', { class: 'btn small', href: `#read?url=${encodeURIComponent(r.best.url)}` }, 'Read'), ext(r.best.url, 'Open on X ↗')))));
}

async function viewStatus() {
  const out = h('div', { class: 'stack' }, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Checking every route…'));
  $main.append(h('h1', { text: 'Status' }), h('p', { class: 'lede', text: 'What works on this machine right now, and how to fix anything that doesn’t.' }), out);
  try {
    const [doc, st, me] = await Promise.all([api('/scour/doctor'), api('/scour/status'), api('/scour/me')]);
    const u = st.usage;
    out.replaceChildren(
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('div', { class: 'kicker', text: 'This month' }),
          h('p', {}, h('strong', { class: 'num', text: `$${(st.spentUsd || 0).toFixed(2)}` }), ' spent'),
          h('p', { class: 'muted', text: st.providers.tavily ? `Tavily: ${u.tavily.used} of ${u.tavily.free} free searches` : 'No search key: using keyless engines' }),
          st.providers.xApi ? h('p', { class: 'muted', text: `X API: ${u['x-api-posts'].used} posts read` }) : null),
        h('div', { class: 'card' }, h('div', { class: 'kicker', text: 'Background service' }),
          h('p', {}, h('span', { class: `dot ${st.service.loaded ? 'ready' : 'degraded'}` }), st.service.loaded ? 'Running' : 'Not running'),
          h('p', { class: 'muted', text: `${st.service.watches} watches · ${st.service.topics} tracked topics · last run ${when(st.service.config.lastTickAt)}` })),
        h('div', { class: 'card' }, h('div', { class: 'kicker', text: 'Cache' }),
          h('p', {}, h('strong', { class: 'num', text: n(st.cache.entries) }), ' pages cached'),
          h('p', { class: 'muted', text: `${(st.cache.bytes / 1048576).toFixed(1)} MB · re-reading these is instant and free` }))),
      accountsCard(me),
      h('h2', { text: 'Sources' }),
      ...doc.sort((a, b) => a.adapter.localeCompare(b.adapter)).map((r) => h('div', { class: 'card' },
        h('div', {}, h('span', { class: `dot ${r.status}` }), h('strong', { text: label(r.adapter) }), h('span', { class: 'muted', text: ` · ${r.capabilities.join(', ')}` })),
        h('p', { class: 'muted', text: r.detail }),
        r.fix ? h('p', {}, h('strong', { text: 'Fix: ' }), r.fix) : null)));
  } catch (err) { out.replaceChildren(errorCard(err)); }
}

/** Your X handle: searches then include your own recent posts, read straight from your public timeline. */
function accountsCard(me) {
  const card = h('div', { class: 'card stack' });
  const render = (data) => {
    const input = h('input', { type: 'text', class: 'input', placeholder: 'your X handle, or a link to one of your posts', 'aria-label': 'Your X handle', autocomplete: 'off', spellcheck: 'false' });
    const save = (handle, remove) => api('/scour/me', { handle, remove }).then((d) => { render(d); toast(d.message || 'Saved'); }).catch((err) => toast(err.message));
    card.replaceChildren(...[
      h('div', { class: 'kicker', text: 'Your X account' }),
      h('p', { class: 'muted', text: 'X searches include your own posts that match: your recent posts read from your public profile (free, no login), and your whole history if you import the archive X lets you download.' }),
      data.x.length
        ? h('div', { class: 'row' }, ...data.x.map((x) => h('span', { class: 'chip', 'aria-pressed': 'true' }, `@${x} `,
            h('button', { class: 'chip-x', 'aria-label': `Remove @${x}`, onclick: () => save(x, true) }, '×'))))
        : null,
      h('form', { class: 'bar', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) save(v, false); } },
        input, h('button', { class: 'btn', type: 'submit' }, 'Save')),
      ...data.archives.map((a) => h('p', { class: 'muted', text: `Archive @${a.handle}: ${n(a.posts)} posts, ${day(a.from)} to ${day(a.to)} (imported ${day(a.importedAt)})` })),
      data.archives.length ? null : h('p', { class: 'muted' }, 'Full history: download your archive on X (Settings → Your account → Download an archive), then run ', h('code', { text: 'scour import x-archive <file.zip>' }), '.')].filter(Boolean));
  };
  render(me);
  return card;
}

// ------------------------------------------------------------------ router

const VIEWS = { read: viewRead, search: viewSearch, research: viewResearch, watch: viewWatch, insights: viewInsights, status: viewStatus };

function route() {
  const [name = 'read', qs = ''] = location.hash.slice(1).split('?');
  const view = VIEWS[name] ? name : 'read';
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $tooltip.hidden = true;
  $main.replaceChildren();
  VIEWS[view](new URLSearchParams(qs));
  $main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function refreshUsage() {
  try {
    const st = await api('/scour/status');
    const el = document.getElementById('usage');
    el.textContent = `$${(st.spentUsd || 0).toFixed(2)} spent${st.providers.tavily ? ` · Tavily ${st.usage.tavily.used}/${st.usage.tavily.free}` : ''}`;
  } catch { /* the pill is optional */ }
}

window.addEventListener('hashchange', route);
route();
refreshUsage();
