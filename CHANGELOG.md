# Changelog

## 0.3.0

**New**
- Trend and pattern insights: `scour track` and `scour insights` (plus the `scour_insights` MCP tool) find which
  formats, opening styles, lengths and posting times get traction on X, the top and rising posts, phrases that
  recur in the best posts, key accounts, and which of several topics is winning over the last 7 days
- Free momentum tracking: recent X posts are re-checked on every run via the syndication endpoint
- Background service with a daily digest: `scour service install|status|tick|digest|logs|uninstall`
  (macOS LaunchAgent; crontab line elsewhere)
- Local web app: `scour ui` with Read, Search, Research, Watch, Insights (charts) and Status views
- Search freshness (`time_range` for Tavily, `freshness` for Brave) used by topic collection
- Accurate search: query operators that work the same on every source. A word with inner capitals (`ToolMark`)
  matches only that spelling, `"exact phrase"`, `-word` leaves results out, `from:handle` keeps one account.
  Results are filtered before trimming to the limit, X results must actually mention the query, and every answer
  says what it hid and why (CLI, web app and MCP)
- X accounts read directly with no login: `scour get x.com/handle` and `from:handle` use the public
  embedded-timeline feed (followers, reposts and quotes included). Accounts named after the query (@ToolmarkAI for
  "ToolMark") are read automatically
- Your own posts: `scour me x <handle or post link>` adds your recent posts to every X search;
  `scour import x-archive <zip>` makes your whole X history searchable, offline and free
- Route problems (a rate limit, an engine cooling down) are reported as notes instead of silently returning less

**Security**
- The local server refuses requests whose Host is not loopback (DNS rebinding) and cross-origin requests (CSRF);
  the web app ships a strict Content-Security-Policy and sanitises all scraped content

## 0.2.0

**New**
- `scour research`: search → rank by phrase-aware relevance → read in full → one numbered, cited
  Markdown pack (also the `scour_research` MCP tool)
- Topic watch: `scour watch --search "topic" -s reddit,hn,x` alerts on new, on-topic results only
- Documents: PDF and Word files convert locally to Markdown
- Screenshots: `scour screenshot`, the `scour_screenshot` MCP tool, and the Firecrawl `screenshot` format
- Images: `scour_read` with `images: N` lets the model see a page's charts and screenshots;
  `--save-images` downloads them
- Structured data: schema.org facts (price, stock, rating, recipes, events, jobs) from JSON-LD,
  shown under the text and via `scour get --structured`
- Platforms: Bluesky, arXiv (full paper text), npm, PyPI; X Articles read in full from the article
  link or the tweet
- Search: several sources at once (`-s reddit,hn,x`), `--sort engagement|recent`, off-topic filtering
- Search backends: Tavily (free 1,000/month, no card) with a local quota guard; Brave metered against
  its monthly credit; official X API as an opt-in paid route
- `scour crawl --jsonl` streams pages as they arrive
- `scour auth` prompts with hidden input; adds `tavily`, `brave`, `searxng`, `x-api`
- Dockerfile and CI (Node 20, 22, 24 and a Docker build)

**Fixes**
- The CLI no longer hangs after an error once the headless browser has started
- Bot-check pages are detected and never returned as content
- Empty responses no longer crash extraction
- YouTube rate limiting is reported plainly with a 45-minute back-off
- The HTTP API refuses private, loopback and cloud-metadata addresses (SSRF guard)

## 0.1.0

First version: cost-tiered fetching with a $0 cap, unified `Document` schema, adapters for Reddit,
X, YouTube, GitHub, Hacker News, Stack Overflow, Wikipedia and RSS, search fan-out, crawl, map,
watch with alerts, CSS extraction, MCP server, Firecrawl-compatible API and `scour setup`.
