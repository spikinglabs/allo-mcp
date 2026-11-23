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

`src/usage.js`, written in the background (`ctx.waitUntil`) after each answer, so it never
blocks or slows a call, and any failure is ignored.

- **Counts** on the shared Allo usage counter (https://monitoring.admin.allo.land/, site
  "Allo Land connector (MCP gateway)"), per day and country: `session`, `client_<assistant>`
  (`claude`, `chatgpt`, `cursor`, …, `other`), `tool_<prefix>_<name>`, `error`.
  Service binding `COUNT` to the `allo-count` Worker (spikinglabs/alloland-rebirth, `workers/count`).
- **Raw log** in the private R2 bucket `allo-mcp-logs` (binding `LOGS`):
  `logs/<day>/<HHMMSSmmm>-<random>.ndjson`, one line per JSON-RPC request with `t`, `method`,
  `tool`, `service`, `client`, `proto`, `ua` (first product token), `country`, `ms`, `ok`, `err`.
  No IP address, no IDs or cookies, no tool arguments, nothing from the answers.
  Notifications and pings are not logged.

Free-tier budget: one R2 write per logged POST against 1 million writes a month for the whole
Cloudflare account (shared with the Allo Cars MCP log) and 10 GB of storage. Set
`USAGE = "off"` in `wrangler.toml` to stop counts and logs.

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
