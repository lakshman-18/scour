# scour

**Read and search anything on the internet for $0.** CLI + MCP server + library.

```bash
scour get https://www.reddit.com/r/LocalLLaMA/comments/1wvpxg8/   # threaded comments, no login
scour get https://www.youtube.com/watch?v=zjkBMFhNj_g             # full transcript
scour search "web scraping llm"                                   # 7 platforms in parallel
scour watch https://simonwillison.net/atom/everything/            # only what's new since last run
```

Every source (tweet, Reddit thread, YouTube video, GitHub issue, any web page) comes back
as **one `Document` shape**, so whatever runs downstream never needs per-site handling.

```bash
scour setup                       # plug into Claude Code (MCP + skill) — one command
scour serve                       # local Firecrawl-compatible API on :3002 (works with Firecrawl SDKs, n8n, LangChain)
scour map https://docs.example.com            # every URL on a site in ~1s (sitemap + llms.txt + links)
scour watch https://news.ycombinator.com/ --notify ntfy:my-topic --every 30m   # phone push on new items
scour search "OpenAI Dots" -s twitter         # X topic search, no login (indexed tweets)
scour get https://x.com/user/status/123 -o article.md   # a long-form X Article as a clean Markdown file
scour get https://x.com/user/status/123 --save-images ./imgs   # …and its charts/screenshots as files
```

---

## Why it's cheap: the tier ladder

Every fetch climbs from the cheapest tier and stops at the first one that works:

| Tier | What | Cost |
|---|---|---|
| 0 · cache | content-addressed local cache | free, ~0 ms |
| 1 · native | the platform's own public endpoints (syndication JSON, Algolia, REST, page fragments) | free |
| 1½ · served Markdown | asks for `Accept: text/markdown` first; Cloudflare "Markdown for Agents" sites answer 17–30× smaller | free |
| 2 · static | plain HTTP + Readability → Markdown | free |
| 3 · headless | Playwright render, for JS-only pages | free (CPU) |
| 4 · paid | Jina / Firecrawl / Brave / Exa | **refused unless you set `--max-cost`** |

The default budget cap is **$0**. The ledger charges *before* any paid request,
so a run can't overspend by accident.

Measured on 2026-10-02 (`npm run smoke`, cache bypassed):

```
✓ web article            2409ms  [static]   web/http+readability
✓ web JS-rendered        4283ms  [headless] web/playwright+readability
✓ feed (sniffed)          512ms  [static]   web/sniffed atom
✓ hn thread              2318ms  [native]   hn/algolia items
✓ github repo             607ms  [native]   github/rest repos
✓ reddit subreddit       1467ms  [native]   reddit/listing fragment
✓ reddit thread          2705ms  [native]   reddit/oembed + comment fragment + atom
✓ twitter tweet           663ms  [native]   twitter/syndication cdn
✓ youtube transcript     4441ms  [headless] youtube/player api + yt-dlp
✓ wikipedia               815ms  [native]   wikipedia/action api extracts
✓ stackoverflow          1100ms  [native]   stackoverflow/se questions
✓ search: fan-out        2368ms  [native]   multi/hn+github+youtube+wikipedia+stackoverflow+websearch
all routes healthy · spent $0.0000
```

## What works with zero config

| Source | Read | Search | Notes |
|---|---|---|---|
| Any web page | ✓ | via `websearch` | Readability → Markdown; tables, code languages and absolute links kept |
| RSS / Atom / JSON Feed | ✓ | — | detected from the content, not the URL |
| Reddit | posts, threaded comments, subreddits | ✓ | uses page fragments when anonymous JSON is blocked; no login |
| Twitter / X | tweets, media, quotes, and full long-form **X Articles** (from the article link or the tweet), no account | ✓ | free: indexed popular tweets via search engines · live: official X API, pay-per-use $0.005/post, only when `--max-cost` allows |
| YouTube | metadata, transcript | ✓ | transcripts need yt-dlp, found on PATH or run through `pipx`/`uvx` |
| GitHub | repos, README, issues, PRs, files, profiles | ✓ | 60 req/h anonymous; `GITHUB_TOKEN` gives 5000 |
| Hacker News | stories, comment trees, front page | ✓ | Algolia API, unlimited |
| Stack Overflow / SE | questions + ranked answers | ✓ | |
| Wikipedia | full article text | ✓ | |
| Web search | — | ✓ | SearXNG → Tavily → Brave → DuckDuckGo → Marginalia → Exa; keyed providers capped at their free monthly allowance |

Run `scour doctor` to see what works on *your* machine right now and exactly what to do about anything that doesn't.

## Workflow commands

```bash
# Batch: many URLs, bounded concurrency. Partial failure is normal; failures are listed, not thrown.
cat urls.txt | scour get - --json > out.json

# Search, then fetch the full text of every hit
scour search "rust async runtime" --source hn --fetch

# Crawl: sitemap-seeded, robots.txt respected, bounded by default
scour crawl https://docs.example.com -n 100 -d 2 --include '/guides/' -o docs.json

# Watch: cron-safe change detection. Feeds and listings report NEW ITEMS; pages report a diff.
# Exit codes follow diff(1): 0 unchanged, 1 changed, 2 error
scour watch https://news.ycombinator.com/ --label hn
scour watch --all --quiet-if-unchanged || ./notify.sh

# Extract: CSS selectors → JSON records. Deterministic, no LLM.
scour extract https://news.ycombinator.com/ --list "tr.athing" \
  -f "title=.titleline > a" -f "url=.titleline > a@href" -f "rank=.rank"
```

Useful flags on every command: `--json`, `--stats` (tier, bytes and cost on stderr),
`--max-tier static|headless|paid`, `--max-cost 0.05`, `--no-cache`, `--ttl 600`,
`--proxy http://…`, `-v` (shows the ladder and every fallback).

## Use from an agent (MCP)

```bash
scour setup                 # Claude Code: MCP server + a skill that teaches Claude when to use scour
scour setup --all           # also Claude Desktop and Cursor (backs up their configs first)
scour setup --remove        # undo
```

Tools: `scour_read`, `scour_search`, `scour_read_many`, `scour_crawl`, `scour_map`, `scour_watch`, `scour_extract`.

`scour_read` with `images: N` attaches the page's images (charts, screenshots, dashboards) so the agent can
see them. scour does no image recognition itself; the calling model does, so this costs nothing extra.

## Use from anything that speaks HTTP (n8n, Zapier, Make, LangChain, Dify…)

```bash
scour serve                 # http://127.0.0.1:3002 — same port as self-hosted Firecrawl
```

It implements Firecrawl's API (`/v1` and `/v2`: scrape, crawl, batch scrape, map, search), verified with
Firecrawl's official SDK (`npm run compat`). Any Firecrawl integration works by setting its base URL to
`http://127.0.0.1:3002`; the API key can be anything unless you set `SCOUR_API_KEY`. Native routes:
`GET /scour/get?url=…`, `GET /scour/search?q=…&source=…`, `POST /scour/watch`, `POST /scour/extract`,
`GET /scour/doctor`. It binds to localhost only, and refuses other interfaces without an API key.

Not yet supported in the Firecrawl API: `json`/`extract` formats (LLM extraction), `screenshot`, and actions.

## Alerts

`watch` targets are saved with the watch, so `scour watch --all` (or `--every 30m`) alerts each one where you asked:

| Target | Example |
|---|---|
| Phone push (free, no account) | `--notify ntfy:my-secret-topic` then subscribe in the ntfy app |
| Slack / Discord | `--notify slack:https://hooks.slack.com/…` · `--notify discord:https://discord.com/api/webhooks/…` |
| Telegram | `--notify telegram:<chat_id>@<bot_token>` |
| n8n / Zapier / Make / your code | `--notify webhook:https://…` (POSTs `{event, summary, newItems[], diff}`) |
| This Mac | `--notify macos` |

`scour watch --test-notify --notify <target>` sends a test. Watch state is stored mode 0600 because it holds webhook URLs.
Each result ends with a provenance line (tier, ms, $) so the agent can see what it spent.

## Use as a library

```ts
import { createScour, watch } from 'scour';

const s = await createScour();
const doc = await s.get('https://x.com/karpathy/status/1886192184808149383');
doc.text;                 // Markdown
doc.author?.handle;       // "karpathy"
doc.engagement?.score;    // likes / upvotes / stars — whatever the platform's signal is
doc.provenance.tierName;  // "native"
doc.provenance.costUsd;   // 0

const { newItems } = await watch(s, 'https://simonwillison.net/atom/everything/');
```

## Install

```bash
npm install && npm run build
npm link                                   # puts `scour` on your PATH

# Optional, unlocks more:
npm i -D playwright && npx playwright install chromium   # JS-heavy pages
brew install yt-dlp        # YouTube transcripts (or just have pipx/uv installed)
scour auth tavily          # reliable web + X topic search: free 1,000/month, no card (prompts, hidden)
scour auth github --token "$(gh auth token)"   # 60 → 5000 req/h
scour auth x-api           # optional: live X search, pay-per-use $0.005/post, used only with --max-cost
```

Config: env vars (`SCOUR_MAX_TIER`, `SCOUR_MAX_COST`, `SCOUR_PROXY`, `SCOUR_TTL`, `SEARXNG_URL`,
`BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `JINA_API_KEY`, …) or `~/.scour/config.json`.
Credentials live in `~/.scour/credentials.json` with mode 0600 and are sent only to the platform they belong to.

## Add a platform in ~50 lines

```ts
import type { Adapter } from 'scour';

export const lobstersAdapter: Adapter = {
  name: 'lobsters',
  priority: 50,
  match: (url) => url.hostname === 'lobste.rs',
  async fetch(url, ctx) {
    const json = await ctx.http.json<any>(`${url.href.replace(/\/$/, '')}.json`);
    return {
      id: `lobsters:${json.short_id}`, url: json.url || url.href, source: 'lobsters', kind: 'post',
      title: json.title, text: json.description_plain ?? '',
      engagement: { score: json.score, comments: json.comment_count },
      provenance: { /* tier: Tier.Native, adapter: 'lobsters', … */ } as any,
    };
  },
};
// registry.register(lobstersAdapter)
```

Throw `TierError` to say "can't do it at this tier". The pipeline then falls back to the generic web adapter
and records the attempt in `provenance.attempts`.

## Limits and deliberate choices

- **No CAPTCHA solving, no forged attestation tokens, no anti-bot evasion code.** When a platform puts
  up a challenge, scour uses another legitimate route or tells you it can't. Example: YouTube now
  token-gates caption files, so transcripts go through yt-dlp instead of a token forger.
- **Reddit** anonymous JSON is blocked from many IPs, so scour reads the HTML fragments reddit.com itself loads.
  On that route, post vote counts aren't available (comment scores are). Free OAuth credentials restore them.
- **Twitter** search and timelines need a session; single tweets don't.
- `crawl` respects robots.txt and paces each host (250 ms default). Single `get` calls are treated as
  user-directed and don't check robots.
- **Keyless web search is the most fragile route.** Search engines rate-limit scrapers; after heavy use
  DuckDuckGo shows a CAPTCHA, and scour backs off for 30 minutes and falls through to Marginalia.
  For dependable search use `scour auth tavily` (1,000 free/month, no card) or self-host SearXNG.
- **Free allowances are enforced locally.** Brave's free plan ended in Feb 2026 (now $5/month credit, then
  billed to a card with no cap); scour counts Tavily/Brave usage in `~/.scour/usage.json` and stops at 950/month
  unless you raise `--max-cost`. `scour doctor` shows this month's usage.
- **X:** scour never logs in to X. Reading tweets and indexed search use no account at all. The unofficial
  cookie route (`scour auth twitter`) automates a logged-in session, which breaks X's terms and can get the
  account locked or suspended; the official API is the safe way to get live search.
  Marginalia's results are CC-BY-NC-SA (non-commercial), so swap it out before selling a product built on it.
- **X topic search without a login** depends on web search working (it finds tweet URLs through
  search engines, then reads each tweet in full). With keyless engines rate-limited, set up Tavily.
- Platforms change. `npm run smoke` is a live canary; run it on a schedule.

## Development

```bash
npm run build      # tsc
npm test           # 42 offline tests, no network
npm run smoke      # live canary against real sites
npm run compat     # drives `scour serve` with Firecrawl's official SDK
```

MIT
