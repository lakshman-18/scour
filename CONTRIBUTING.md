# Contributing to scour

Thanks for helping. scour's value is that it keeps working as platforms change, so the most useful
contributions are new platform adapters, fixes to routes that broke, and better extraction.

## Setup

```bash
git clone https://github.com/lakshman-18/scour && cd scour
npm install && npm run build
npm test            # offline tests; must pass
npm run smoke       # live checks against real sites (use a home connection; CI IPs get blocked)
```

Run the CLI from source with `node bin/scour.js …` after `npm run build`, or `npm run dev -- get <url>`.

## How it fits together

- `src/core/pipeline.ts`: the engine. Picks an adapter, walks the cost tiers, caches, meters spend.
- `src/core/types.ts`: the unified `Document` every adapter returns.
- `src/adapters/*`: one file per platform. `generic.ts` handles everything else on the web.
- `src/workflows/*`: batch, crawl, map, watch, research, extract, built on `Scour.get` and `Scour.search`.
- `src/mcp/server.ts`, `src/server/serve.ts`, `src/cli.ts`: the three front doors.

## Adding a platform

An adapter is about 50 lines: a `match()` that claims URLs, a `fetch()` that returns a `Document`,
and optionally `search()` and `health()`.

```ts
import { Tier, TierError, type Adapter } from '../core/types.js';
import { makeDoc, prov } from './_helpers.js';

export const lobstersAdapter: Adapter = {
  name: 'lobsters',
  priority: 50,
  match: (url) => url.hostname === 'lobste.rs' && url.pathname.startsWith('/s/'),
  async fetch(url, ctx) {
    const s = await ctx.http.json<any>(`${url.href.replace(/\/$/, '')}.json`, { timeoutMs: ctx.options.timeoutMs });
    if (!s?.short_id) throw new TierError('No story here', Tier.Native); // falls back to the generic adapter
    return makeDoc({
      url: s.short_id_url, source: 'lobsters', nativeId: s.short_id, kind: 'post',
      title: s.title, text: s.description_plain || s.url,
      author: { handle: s.submitter_user },
      engagement: { score: s.score, comments: s.comment_count },
      provenance: prov({ tier: Tier.Native, adapter: 'lobsters', strategy: 'story json', finalUrl: url.href }),
    });
  },
};
```

Register it in `defaultRegistry()` in `src/index.ts`, add a routing case to `test/core.test.js`, a
parser test with a captured payload to `test/adapters.test.js`, and a live check to `test/smoke.mjs`.

Throw `TierError` to say "not at this tier": the engine records the attempt and falls back to the
generic web adapter. Use `ctx.http` (not `fetch`) so requests are paced, metered and cancellable.

## Ground rules

These are product decisions, not style preferences. PRs that cross them won't be merged.

- **No CAPTCHA solving, token forging, fingerprint spoofing or other anti-bot evasion.** If a site
  puts up a human check, detect it and fail clearly.
- **Free by default.** Anything that costs money must go through `ctx.budget` before the request and
  must be off unless the user raises `--max-cost`. Free allowances go through `core/usage.ts`.
- **No secrets in output or logs.** Credentials live in `~/.scour` (mode 0600) and are sent only to
  their own service. Redact webhook URLs and keys anywhere they might be printed.
- **Never return a wrong page as success.** Thin pages escalate; challenge pages fail; empty results
  say so.

## Pull requests

- `npm run build && npm test` must pass.
- Include the smoke output for any route you touched.
- One feature or fix per PR, with a short description of what you checked by hand.
