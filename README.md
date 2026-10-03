# scour

**Read and search anything on the internet for $0.** Reddit threads, tweets and X Articles, YouTube
transcripts, GitHub, papers, PDFs, docs and any web page, as clean Markdown your AI can use.
A CLI, an MCP server for Claude/Cursor, and a Firecrawl-compatible API, all running on your machine.

[![ci](https://github.com/lakshman-18/scour/actions/workflows/ci.yml/badge.svg)](https://github.com/lakshman-18/scour/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/scour-cli)](https://www.npmjs.com/package/scour-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npm i -g scour-cli

scour get https://x.com/someone/status/123             # a tweet, or the full X Article behind it
scour get https://www.reddit.com/r/LocalLLaMA/comments/…  # the post and its threaded comments
scour get https://www.youtube.com/watch?v=zjkBMFhNj_g   # the transcript
scour get https://arxiv.org/abs/1706.03762              # the whole paper, not just the abstract
scour research "OpenAI Dots" -s reddit,hn,x             # search, read the best results, one cited pack
scour watch --search "my product" -s reddit,x --notify ntfy:my-topic --every 1h   # alerts on new mentions
scour setup                                             # give Claude Code all of this, in one command
```

---

## Why scour

- **Free by default, and it stays free.** Every request starts at the cheapest route that works:
  cache, then the platform's own public endpoints, then a plain page fetch, then a headless browser.
  Paid services are refused unless you raise a spending cap, and free API allowances (Tavily, Brave)
  are counted locally so you're never billed by surprise.
- **Platforms, not just pages.** Generic scrapers return Reddit's or X's page shell. scour reads the
  platforms the way their own apps and embeds do: comment trees, likes, transcripts, full articles.
- **One shape for everything.** A tweet, a thread, a video and a PDF all come back as the same
  `Document` (text, author, date, engagement, media, links, provenance), so nothing downstream
  needs per-site code.
- **Drop-in for what you already use.** `scour serve` speaks Firecrawl's API (v1 and v2, verified
  with Firecrawl's own SDK), so n8n, LangChain, Dify or your own code can switch by changing a URL.

## What it reads

| Source | Read | Search | Notes |
|---|---|---|---|
| Any web page | ✓ | via web search | Readability → Markdown; tables, code languages, absolute links kept; JS pages rendered |
| Sites with Markdown for Agents | ✓ | | asks for `text/markdown` first; Cloudflare sites answer 17–30× smaller |
| PDF and Word documents | ✓ | | converted locally, with page markers |
| Reddit | posts, threaded comments, subreddits | ✓ | works even where Reddit blocks its JSON API |
| X / Twitter | tweets, media, quotes, **full X Articles** | ✓ | no account; search finds indexed tweets, the official API gives live search (paid, opt-in) |
| YouTube | metadata, transcripts | ✓ | transcripts via yt-dlp, found on PATH or run through pipx/uv |
| GitHub | repos, READMEs, issues, PRs, files, profiles | ✓ | 60 req/h anonymous, 5,000 with a free token |
| Hacker News | stories and full comment trees | ✓ | |
| Bluesky | posts with reply threads, profiles | ✓ | public API, no account |
| arXiv | metadata, abstract and **full paper text** | ✓ | |
| npm / PyPI | metadata, downloads, README | npm | |
| Stack Overflow, Wikipedia, RSS/Atom/JSON Feed | ✓ | ✓ | feeds detected by content, not URL |
| Web search | | ✓ | Tavily (1,000 free/month) → SearXNG → DuckDuckGo → Marginalia |

`scour doctor` shows what works on your machine right now, and exactly how to fix anything that doesn't.

## Use it from

**The terminal.** Every command takes `--json`, `--stats` (route, time, cost) and `-o file`.

**Claude Code, Claude Desktop, Cursor (MCP).**

```bash
scour setup                 # Claude Code: MCP server + a skill that teaches Claude when to use it
scour setup --all           # also Claude Desktop and Cursor (backs up their configs first)
scour setup --remove        # undo
```

Nine tools: `scour_read` (with `images: N` to let the model see charts and screenshots),
`scour_read_many`, `scour_search`, `scour_research`, `scour_crawl`, `scour_map`, `scour_screenshot`,
`scour_watch`, `scour_extract`.

**Anything that speaks HTTP.**

```bash
scour serve                 # http://127.0.0.1:3002 — the same port as self-hosted Firecrawl
```

Firecrawl `/v1` and `/v2`: scrape (markdown, links, html, rawHtml, screenshot), crawl, batch scrape,
map and search. Point any Firecrawl client at `http://127.0.0.1:3002`. Native routes:
`/scour/get`, `/scour/search`, `/scour/watch`, `/scour/extract`, `/scour/doctor`.
Localhost only by default; other interfaces need an API key, and requests to private or cloud-metadata
addresses are refused.

```bash
docker build -t scour . && docker run -e SCOUR_API_KEY=change-me -p 127.0.0.1:3002:3002 -v scour-data:/data scour
```

**Your code.**

```ts
import { createScour } from 'scour-cli';
const s = await createScour();
const doc = await s.get('https://news.ycombinator.com/item?id=38792446');
doc.text; doc.author?.handle; doc.engagement?.comments; doc.provenance.costUsd; // 0
```

## Workflows

```bash
# Research: search → rank → read in full → one numbered, cited Markdown pack for any AI
scour research "best local LLM for coding" -s reddit,hn,youtube -n 8 -o pack.md

# Search several platforms at once, most-discussed first
scour search "rust async runtime" -s reddit,hn,x --sort engagement

# Watch a page, a feed, or a topic. Feeds and topics report only NEW items.
scour watch https://simonwillison.net/atom/everything/ --notify macos
scour watch --search "my startup" -s reddit,hn,x --notify slack:https://hooks.slack.com/… --every 30m

# Map a site in a second, crawl it, or stream pages as they arrive
scour map https://docs.example.com --search api
scour crawl https://docs.example.com -n 200 --include '/guides/' --jsonl > docs.jsonl

# Structured data, free: CSS selectors, or the schema.org data pages already publish
scour extract https://news.ycombinator.com --list "tr.athing" -f "title=.titleline > a" -f "url=.titleline > a@href"
scour get https://shop.example.com/product --structured     # price, stock, rating, SKU…

# Images and visuals
scour get https://x.com/someone/status/123 --save-images ./images
scour screenshot https://example.com --full-page -o page.png
```

Alerts go to `ntfy:<topic>` (phone push, free, no account), `slack:<webhook>`, `discord:<webhook>`,
`telegram:<chat_id>@<bot_token>`, `webhook:<url>` (n8n, Zapier, Make) or `macos`. Topic watches only
alert on results that are actually about the topic and newer than the watch.

## What it costs

| | Firecrawl (Sept 2026) | scour |
|---|---|---|
| Page → Markdown | 1 credit (Hobby: $19 for 5,000) | $0 |
| Search | 2 credits per 10 results | $0 (keyless engines, or Tavily's free 1,000/month) |
| JSON extraction | +4 credits per page (LLM) | $0 (selectors or schema.org; your agent does the rest) |
| Change monitoring | 7 credits per page per check | $0 |

The optional paid routes (Firecrawl, Jina with a key, Exa, the official X API) only run when you pass
`--max-cost`, and the ledger is charged *before* each call. `scour doctor` shows this month's usage of
free allowances.

## Optional extras

```bash
npx playwright install chromium   # JS-only pages and screenshots (scour asks for this when needed)
brew install yt-dlp               # YouTube transcripts (or just have pipx/uv installed)
scour auth tavily                 # reliable web + X topic search, free 1,000/month, no card
scour auth github --token "$(gh auth token)"
```

`scour auth <service>` prompts with hidden input and stores keys in `~/.scour` with mode 0600.
They are sent only to the service they belong to.

## Principles and limits

- **No CAPTCHA solving, no forged tokens, no anti-bot evasion.** When a site puts up a human check,
  scour says so and stops; it never returns the check page as if it were content. Some sites
  (IMDb, for example) are therefore unreadable, and that's deliberate.
- `crawl` respects robots.txt and paces each host. Single reads are treated as user-directed.
- **Keyless web search is fragile.** Engines rate-limit heavy use; scour backs off automatically and
  Tavily's free tier fixes it properly.
- **YouTube** token-gates caption files; transcripts need yt-dlp, and heavy use gets a connection
  throttled for a while (scour detects this and backs off).
- **X topic search without the paid API** finds popular, indexed tweets, not a real-time feed.
- Platforms change. `npm run smoke` is a live check of every route; run it on a schedule.

## Development

```bash
npm install && npm run build
npm test           # 50 offline tests
npm run smoke      # live check of every route against real sites
npm run compat     # drives `scour serve` with Firecrawl's official SDK
```

Adding a platform takes about 50 lines; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
