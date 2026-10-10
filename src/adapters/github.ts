import { normDate, tidy } from '../core/extract.js';
import {
  Tier,
  TierError,
  type Adapter,
  type AdapterContext,
  type Document,
  type HealthReport,
  type SearchResult,
} from '../core/types.js';
import { convertDocument, documentFormat } from '../core/documents.js';
import { human, makeDoc, prov, renderThread, truncate } from './_helpers.js';

/**
 * GitHub via the public REST API.
 * Unauthenticated: 60 req/hour. With a free PAT: 5000/hour. Both $0.
 */
const API = 'https://api.github.com';

export const githubAdapter: Adapter = {
  name: 'github',
  priority: 50,

  match(url: URL): boolean {
    return /^(www\.)?github\.com$/.test(url.hostname) || url.hostname === 'raw.githubusercontent.com';
  },

  async fetch(url: URL, ctx: AdapterContext): Promise<Document> {
    if (url.hostname === 'raw.githubusercontent.com') return rawFile(url, ctx);

    const seg = url.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, number] = seg;
    if (!owner) throw new TierError('GitHub URL has no owner segment.', Tier.Native, false);
    if (!repo) return profile(owner, ctx, url);

    if ((kind === 'issues' || kind === 'pull') && number) return issue(owner, repo, kind, number, ctx, url);
    if (kind === 'blob' && seg.length > 4) return blob(owner, repo, seg.slice(3), ctx, url);
    if (kind === 'discussions' && number) {
      // Discussions need GraphQL + auth; the rendered page is free and good enough.
      throw new TierError('GitHub Discussions needs GraphQL auth; falling back to page render.', Tier.Native);
    }
    return repository(owner, repo, ctx, url);
  },

  async search(query: string, ctx: AdapterContext, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, per_page: String(limit), sort: 'stars', order: 'desc' });
    const res = await gh<{ items: GhRepo[] }>(`${API}/search/repositories?${params}`, ctx);
    return (res.items ?? []).map((r) => ({
      title: r.full_name,
      url: r.html_url,
      snippet: r.description ?? undefined,
      source: 'github',
      publishedAt: normDate(r.created_at),
      author: { handle: r.owner?.login, url: r.owner?.html_url },
      engagement: { score: r.stargazers_count, shares: r.forks_count },
      extra: { language: r.language, topics: r.topics, updatedAt: r.updated_at },
    }));
  },

  async health(ctx: AdapterContext): Promise<HealthReport> {
    const token = ctx.config.credentials.githubToken;
    try {
      const res = await ctx.http.get(`${API}/rate_limit`, {
        headers: ghHeaders(ctx), timeoutMs: ctx.options.timeoutMs,
      });
      const remaining = res.headers['x-ratelimit-remaining'] ?? '?';
      const limit = res.headers['x-ratelimit-limit'] ?? '?';
      return {
        adapter: 'github',
        status: token ? 'ready' : 'degraded',
        detail: `${remaining}/${limit} requests remaining this hour${token ? ' (authenticated)' : ' (anonymous)'}.`,
        fix: token ? undefined : 'Set GITHUB_TOKEN to a free PAT to go from 60 to 5000 requests/hour and read private repos.',
        capabilities: token
          ? ['repo', 'issues', 'PRs', 'files', 'search', 'private repos']
          : ['public repo', 'public issues', 'files', 'search'],
      };
    } catch (err) {
      return { adapter: 'github', status: 'down', detail: (err as Error).message, capabilities: [] };
    }
  },
};

interface GhRepo {
  full_name: string; html_url: string; description: string | null; stargazers_count: number;
  forks_count: number; open_issues_count: number; subscribers_count?: number; language: string | null;
  topics?: string[]; created_at: string; updated_at: string; pushed_at: string;
  default_branch: string; license?: { spdx_id: string } | null; archived?: boolean;
  homepage?: string | null; owner?: { login: string; html_url: string; avatar_url: string };
}

function ghHeaders(ctx: AdapterContext): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const t = ctx.config.credentials.githubToken;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function gh<T>(url: string, ctx: AdapterContext): Promise<T> {
  try {
    return await ctx.http.json<T>(url, { headers: ghHeaders(ctx), timeoutMs: ctx.options.timeoutMs });
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b403\b/.test(msg) && !ctx.config.credentials.githubToken) {
      throw new TierError(
        'GitHub rate limit hit (60/hour anonymous). Set GITHUB_TOKEN to a free PAT for 5000/hour: ' +
          'https://github.com/settings/tokens — no scopes needed for public data.',
        Tier.Native,
      );
    }
    throw err;
  }
}

async function repository(owner: string, repo: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const [info, readme] = await Promise.all([
    gh<GhRepo>(`${API}/repos/${owner}/${repo}`, ctx),
    ctx.http
      .get(`${API}/repos/${owner}/${repo}/readme`, {
        headers: { ...ghHeaders(ctx), Accept: 'application/vnd.github.raw' },
        timeoutMs: ctx.options.timeoutMs,
        allowStatus: [404],
      })
      .then((r) => (r.status === 200 ? r.body : ''))
      .catch(() => ''),
  ]);

  const head = [
    `# ${info.full_name}`,
    '',
    info.description ?? '',
    '',
    `⭐ ${human(info.stargazers_count)} · 🍴 ${human(info.forks_count)} · ` +
      `issues ${human(info.open_issues_count)} · ${info.language ?? 'n/a'} · ` +
      `${info.license?.spdx_id ?? 'no license'}${info.archived ? ' · **ARCHIVED**' : ''}`,
    `Updated ${info.pushed_at?.slice(0, 10)}${info.homepage ? ` · ${info.homepage}` : ''}`,
    info.topics?.length ? `\nTopics: ${info.topics.join(', ')}` : '',
    '',
    readme ? '---\n' : '',
    readme,
  ];

  return makeDoc({
    url: info.html_url,
    source: 'github',
    nativeId: info.full_name,
    kind: 'repository',
    title: info.full_name,
    text: tidy(head.join('\n')),
    excerpt: info.description ?? undefined,
    author: info.owner ? { handle: info.owner.login, url: info.owner.html_url, avatar: info.owner.avatar_url } : undefined,
    publishedAt: normDate(info.created_at),
    updatedAt: normDate(info.pushed_at),
    engagement: { score: info.stargazers_count, shares: info.forks_count },
    tags: info.topics ?? [],
    extra: {
      language: info.language, defaultBranch: info.default_branch,
      openIssues: info.open_issues_count, archived: info.archived, homepage: info.homepage,
    },
    provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: 'rest repos', finalUrl: info.html_url, httpStatus: 200 }),
  });
}

interface GhIssue {
  number: number; title: string; body: string | null; state: string; html_url: string;
  user?: { login: string; html_url: string }; created_at: string; updated_at: string;
  comments: number; labels?: { name: string }[]; pull_request?: unknown;
  merged?: boolean; draft?: boolean; reactions?: { total_count: number };
}

async function issue(owner: string, repo: string, kind: string, number: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const isPr = kind === 'pull';
  const base = `${API}/repos/${owner}/${repo}/${isPr ? 'pulls' : 'issues'}/${number}`;
  const info = await gh<GhIssue>(base, ctx);
  const wantComments = ctx.options.comments !== false && ctx.options.comments !== 0;

  const comments = wantComments
    ? await gh<{ user?: { login: string }; body: string; created_at: string; html_url: string; id: number }[]>(
        `${API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
        ctx,
      ).catch(() => [])
    : [];

  const kids = comments.map((c) =>
    makeDoc({
      url: c.html_url, source: 'github', nativeId: String(c.id), kind: 'comment',
      text: (c.body ?? '').trim(),
      author: { handle: c.user?.login },
      publishedAt: normDate(c.created_at),
      provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: 'rest comments', finalUrl: c.html_url }),
    }),
  );

  const status = isPr ? (info.merged ? 'merged' : info.draft ? 'draft' : info.state) : info.state;
  const body = [
    `# ${isPr ? 'PR' : 'Issue'} #${info.number}: ${info.title}`,
    '',
    `**${status}** · opened by ${info.user?.login ?? '?'} on ${info.created_at.slice(0, 10)} · ${info.comments} comments` +
      (info.labels?.length ? ` · labels: ${info.labels.map((l) => l.name).join(', ')}` : ''),
    '',
    (info.body ?? '_No description._').trim(),
  ];
  if (kids.length) body.push('', '---', '', '## Comments', '', renderThread(kids));

  return makeDoc({
    url: info.html_url,
    source: 'github',
    nativeId: `${owner}/${repo}#${info.number}`,
    kind: 'issue',
    title: info.title,
    text: tidy(body.join('\n')),
    excerpt: truncate((info.body ?? '').replace(/\s+/g, ' '), 280) || undefined,
    author: info.user ? { handle: info.user.login, url: info.user.html_url } : undefined,
    publishedAt: normDate(info.created_at),
    updatedAt: normDate(info.updated_at),
    engagement: { score: info.reactions?.total_count, comments: info.comments },
    tags: info.labels?.map((l) => l.name) ?? [],
    children: kids,
    extra: { state: status, isPullRequest: isPr, repo: `${owner}/${repo}` },
    provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: `rest ${isPr ? 'pulls' : 'issues'}`, finalUrl: info.html_url, httpStatus: 200 }),
  });
}

async function blob(owner: string, repo: string, rest: string[], ctx: AdapterContext, url: URL): Promise<Document> {
  const [ref, ...pathParts] = rest;
  const filePath = pathParts.join('/');
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  return rawFile(new URL(raw), ctx, url.href);
}

async function rawFile(url: URL, ctx: AdapterContext, canonical?: string): Promise<Document> {
  const res = await ctx.http.get(url.href, { timeoutMs: ctx.options.timeoutMs, headers: ghHeaders(ctx) });
  const name = decodeURIComponent(url.pathname.split('/').pop() ?? 'file');
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const isMarkdown = /^(md|markdown|mdx)$/i.test(ext);
  // Documents kept in a repo (PDF, Word, PowerPoint, Excel, EPUB, CSV) read as Markdown, not as code.
  const format = documentFormat('', name);
  if (format && res.raw?.length) {
    const conv = await convertDocument(res.raw, format);
    return makeDoc({
      url: canonical ?? url.href, source: 'github', kind: 'file', title: conv.title || name, text: conv.text,
      author: conv.author ? { name: conv.author } : undefined,
      extra: { path: url.pathname, bytes: res.bytes, format, pages: conv.pages },
      provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: `raw ${format} → markdown`, finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
    });
  }
  if (!res.body && res.raw?.length) {
    throw new TierError(`${name} is a binary file (${human(res.raw.length)} bytes); scour reads text and documents.`, Tier.Native, false);
  }
  return makeDoc({
    url: canonical ?? url.href,
    source: 'github',
    kind: 'file',
    title: name,
    text: isMarkdown ? res.body : `\`\`\`${ext}\n${res.body}\n\`\`\``,
    extra: { path: url.pathname, bytes: res.bytes, language: ext },
    provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: 'raw file', finalUrl: res.url, httpStatus: res.status, bytes: res.bytes }),
  });
}

async function profile(owner: string, ctx: AdapterContext, url: URL): Promise<Document> {
  const [user, repos] = await Promise.all([
    gh<{ login: string; name: string | null; bio: string | null; html_url: string; avatar_url: string; followers: number; public_repos: number; company: string | null; blog: string | null; location: string | null; created_at: string }>(
      `${API}/users/${owner}`, ctx,
    ),
    gh<GhRepo[]>(`${API}/users/${owner}/repos?sort=updated&per_page=20`, ctx).catch(() => [] as GhRepo[]),
  ]);
  const lines = repos.map((r) => `- **[${r.full_name.split('/')[1]}](${r.html_url})** ⭐${human(r.stargazers_count)} — ${r.description ?? ''}`);
  return makeDoc({
    url: user.html_url,
    source: 'github',
    nativeId: user.login,
    kind: 'profile',
    title: user.name ?? user.login,
    text: tidy([
      `# ${user.name ?? user.login} (@${user.login})`, '',
      user.bio ?? '', '',
      `${human(user.followers)} followers · ${user.public_repos} public repos` +
        (user.company ? ` · ${user.company}` : '') + (user.location ? ` · ${user.location}` : ''),
      user.blog ? `\n${user.blog}` : '', '',
      lines.length ? '## Recent repositories\n' : '', ...lines,
    ].join('\n')),
    author: { handle: user.login, name: user.name ?? undefined, url: user.html_url, avatar: user.avatar_url, followers: user.followers },
    publishedAt: normDate(user.created_at),
    engagement: { score: user.followers },
    provenance: prov({ tier: Tier.Native, adapter: 'github', strategy: 'rest users', finalUrl: user.html_url, httpStatus: 200 }),
  });
}

