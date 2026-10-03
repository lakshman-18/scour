import { normDate, tidy } from '../core/extract.js';
import { Tier, TierError, type Adapter, type AdapterContext, type Document, type SearchResult } from '../core/types.js';
import { human, makeDoc, prov, truncate } from './_helpers.js';

/** npm packages: latest manifest, weekly downloads and README. Free public APIs. */
export const npmAdapter: Adapter = {
  name: 'npm',
  priority: 50,

  match(url: URL): boolean {
    return /^(www\.)?npmjs\.com$/.test(url.hostname) && url.pathname.startsWith('/package/');
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const name = decodeURIComponent(url.pathname.replace(/^\/package\//, '').replace(/\/v\/.*$/, '').replace(/\/$/, ''));
    if (!name) throw new TierError('No package name in npm URL', Tier.Native, false);
    // The full registry document can be tens of MB; the "latest" manifest is a few KB.
    const [m, dl, readme, times] = await Promise.all([
      ctx.http.json<Record<string, any>>(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`, { timeoutMs: ctx.options.timeoutMs }),
      ctx.http.json<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${name}`, { timeoutMs: ctx.options.timeoutMs }).catch(() => ({ downloads: undefined })),
      fetchReadme(`https://cdn.jsdelivr.net/npm/${name}@latest`, ctx),
      ctx.http.json<{ modified?: string; created?: string }>(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, {
        timeoutMs: ctx.options.timeoutMs, headers: { Accept: 'application/vnd.npm.install-v1+json' },
      }).catch(() => ({} as { modified?: string; created?: string })),
    ]);
    const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url;
    const deps = Object.keys(m.dependencies ?? {});
    const head = [
      `# ${m.name}@${m.version}`, '', m.description ?? '', '',
      `${human(dl.downloads)} downloads/week · ${m.license ?? 'no license'} · ${deps.length} dependencies` +
        (m.engines?.node ? ` · node ${m.engines.node}` : ''),
      [m.homepage && `Homepage: ${m.homepage}`, repo && `Repo: ${String(repo).replace(/^git\+/, '').replace(/\.git$/, '')}`].filter(Boolean).join(' · '),
      m.keywords?.length ? `Keywords: ${m.keywords.slice(0, 15).join(', ')}` : '',
      '',
      readme ? `---\n\n${readme}` : '_No README published._',
    ];
    return makeDoc({
      url: `https://www.npmjs.com/package/${name}`, source: 'npm', nativeId: name, kind: 'repository',
      title: `${m.name}@${m.version}`, text: tidy(head.join('\n')), excerpt: m.description,
      author: m.author ? { name: typeof m.author === 'string' ? m.author : m.author.name } : undefined,
      updatedAt: normDate(times.modified), engagement: { views: dl.downloads }, tags: m.keywords ?? [],
      extra: { version: m.version, license: m.license, dependencies: deps, weeklyDownloads: dl.downloads, repository: repo },
      provenance: prov({ tier: Tier.Native, adapter: 'npm', strategy: 'registry latest + downloads + readme', finalUrl: url.href, httpStatus: 200 }),
    });
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const r = await ctx.http.json<{ objects: { package: { name: string; version: string; description?: string; date?: string; links?: { npm?: string }; publisher?: { username?: string } }; score?: { final?: number } }[] }>(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`, { timeoutMs: ctx.options.timeoutMs },
    );
    return r.objects.map((o) => ({
      title: `${o.package.name}@${o.package.version}`,
      url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
      snippet: o.package.description, source: 'npm', publishedAt: normDate(o.package.date),
      author: o.package.publisher?.username ? { handle: o.package.publisher.username } : undefined,
    }));
  },
};

/** PyPI packages: metadata, README and recent downloads. Free public APIs. */
export const pypiAdapter: Adapter = {
  name: 'pypi',
  priority: 50,

  match(url: URL): boolean {
    return /^(www\.)?pypi\.org$/.test(url.hostname) && url.pathname.startsWith('/project/');
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    const name = url.pathname.split('/').filter(Boolean)[1];
    if (!name) throw new TierError('No project name in PyPI URL', Tier.Native, false);
    const [j, stats] = await Promise.all([
      ctx.http.json<{ info: Record<string, any>; urls?: { upload_time_iso_8601?: string }[] }>(`https://pypi.org/pypi/${name}/json`, { timeoutMs: ctx.options.timeoutMs }),
      ctx.http.json<{ data?: { last_week?: number; last_month?: number } }>(`https://pypistats.org/api/packages/${name.toLowerCase()}/recent`, { timeoutMs: ctx.options.timeoutMs }).catch(() => ({ data: undefined })),
    ]);
    const i = j.info;
    const links = Object.entries((i.project_urls ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`);
    const head = [
      `# ${i.name} ${i.version}`, '', i.summary ?? '', '',
      `${human(stats.data?.last_week)} downloads/week · ${i.license_expression ?? i.license ?? 'no license'} · Python ${i.requires_python ?? 'any'}`,
      links.slice(0, 6).join(' · '), '',
      i.description ? `---\n\n${i.description_content_type?.includes('markdown') ? i.description : `\`\`\`\n${i.description}\n\`\`\``}` : '_No description published._',
    ];
    return makeDoc({
      url: `https://pypi.org/project/${i.name}/`, source: 'pypi', nativeId: i.name, kind: 'repository',
      title: `${i.name} ${i.version}`, text: tidy(head.join('\n')), excerpt: i.summary,
      author: i.author || i.author_email ? { name: i.author || String(i.author_email).split('<')[0]!.trim() } : undefined,
      updatedAt: normDate(j.urls?.[0]?.upload_time_iso_8601), engagement: { views: stats.data?.last_week },
      tags: (i.keywords ? String(i.keywords).split(/[,\s]+/) : []).filter(Boolean).slice(0, 15),
      extra: { version: i.version, requiresPython: i.requires_python, weeklyDownloads: stats.data?.last_week },
      provenance: prov({ tier: Tier.Native, adapter: 'pypi', strategy: 'pypi json + pypistats', finalUrl: url.href, httpStatus: 200 }),
    });
  },
};

async function fetchReadme(base: string, ctx: AdapterContext): Promise<string> {
  for (const f of ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']) {
    try {
      const r = await ctx.http.get(`${base}/${f}`, { timeoutMs: ctx.options.timeoutMs, retries: 0, allowStatus: [404] });
      if (r.status === 200 && r.body.trim()) return r.body;
    } catch {
      // try the next casing
    }
  }
  return '';
}
