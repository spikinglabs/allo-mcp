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

## Plain HTTP API (for ChatGPT GPTs and other OpenAPI clients)

The same tools are also served as plain HTTP, for clients that take an OpenAPI
spec instead of MCP (ChatGPT GPT Actions, for example):

- `GET /openapi.json`: OpenAPI 3.1, generated from the live tool list. One
  operation per tool, `POST /api/<tool>`; tools that write (the Outings
  suggestions) are marked `x-openai-isConsequential: true`, so ChatGPT asks
  the user before sending.
- `POST /api/<tool>` with the tool's arguments as a JSON object. Answers
  `{"result": ...}` (the tool's JSON, or its text), or `{"error": "..."}`.
  Answers over 90k characters are cut and carry `"truncated": true`.
- `GET /privacy`: a short privacy note for app directories.

## MCP Registry

`server.json` describes the server for the official MCP Registry as
`io.github.spikinglabs/allo-mcp`. Run the "Publish to MCP Registry" workflow
by hand (Actions tab) to list it or to publish a new version; bump `version`
in `server.json` first. It logs in with GitHub OIDC, so no secret is needed.

## Use it

Add `https://mcp.allo.land/mcp` as a custom connector (Claude: Settings →
Connectors → Add custom connector). No sign-in needed.
