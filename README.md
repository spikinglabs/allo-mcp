# Allo Land MCP gateway

One MCP endpoint for every Allo service: **`https://mcp.allo.land/mcp`**

It lists the tools of each Allo MCP server under a prefix and passes every call
through to the server that owns the tool. The servers themselves keep running
at their own URLs, unchanged.

| Prefix | Service | Server |
|---|---|---|
| `cars_` | Allo Cars | https://cars.allo.land/mcp |
| `outings_` | Allo Outings | https://outings.allo.land/mcp |

Example: `outings_search` calls `search` on Allo Outings.

## How it works

- Cloudflare Worker (SpikingLabs account), Streamable HTTP transport, stateless,
  JSON answers. No sign-in, same as the servers behind it.
- `initialize` returns one set of instructions: a short intro plus each
  server's own instructions.
- Each server's tool list is fetched and cached for 5 minutes per isolate. A
  new tool on a server shows up without a gateway deploy. If a server is down,
  the last good list is served, and the other servers' tools keep working.
- Upstream JSON-RPC errors are passed through as they are; a server that can't
  be reached gives a tool result with `isError: true`.

## Usage counts and logs

Nothing is written to storage on a call. Instead:

- **During the day**, each request becomes one data point in Workers Analytics Engine
  (`src/usage.js`, dataset `allo_mcp_usage`). `writeDataPoint` returns at once and errors are
  ignored, so it never blocks, slows or breaks a call. Notifications and pings are skipped.
- **Once a day** at 01:20 UTC (`src/export.js`, cron), yesterday becomes one file in the private
  R2 bucket `allo-mcp-logs`, `logs/<YYYY-MM-DD>.ndjson`, and its totals go to the shared Allo usage
  counter (https://monitoring.admin.allo.land/, "Allo Land connector (MCP gateway)"): `session`,
  `client_<assistant>`, `tool_<prefix>_<name>`, `error`, per country. Days missed in the last
  week are caught up; a day already in R2 is never exported twice.

A log line has `t`, `method`, `tool`, `service`, `client`, `clientVersion`, `proto`, `ua` (first
User-Agent token), `country`, `ms`, `ok`, `err`, and `sample` when Analytics Engine sampled.
Never an IP address, ID, cookie, tool arguments or anything from the answers.

Free-tier budget: Analytics Engine 100,000 data points a day (past that, points are dropped,
not billed) and 10,000 read queries a day (the export uses 24); R2 one write a day; the counter
one call a day. Analytics Engine keeps points for 3 months, so the R2 files are the long-term copy.

Setup: the GitHub secret `CLOUDFLARE_ANALYTICS_TOKEN` (an API token with Account → Account
Analytics → Read on the SpikingLabs account). The deploy workflow stores it, with the account ID,
as the Worker secrets `AE_API_TOKEN` and `ACCOUNT_ID`. Set `USAGE = "off"` in `wrangler.toml` to
stop recording and exporting.

## Add a server

Add one entry to `src/upstreams.js` (`prefix`, `title`, `url`, `site`) and deploy.
Never rename a prefix once it is in use: clients store tool names.

## Develop

```sh
npm install
npm test          # unit tests, no network
npm run smoke     # runs the gateway in Node against the live servers
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy; set CLOUDFLARE_ACCOUNT_ID to the SpikingLabs account
```

Cost: Workers free tier (100k requests a day).

## Deploy on merge

`.github/workflows/deploy.yml` deploys every push to `main`. It needs two repo
secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID`: the SpikingLabs account ID
- `CLOUDFLARE_API_TOKEN`: a token from the "Edit Cloudflare Workers" template,
  limited to the SpikingLabs account and the allo.land zone

Until both exist, the workflow passes without deploying.

## Use it

Add `https://mcp.allo.land/mcp` as a custom connector (Claude: Settings →
Connectors → Add custom connector). No sign-in needed.
