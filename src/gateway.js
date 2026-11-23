// Allo MCP gateway: one Streamable HTTP MCP endpoint (stateless, JSON responses)
// that lists the tools of every Allo MCP server under a prefix and passes each
// call through to the server that owns the tool.

import { usageEvent, recordUsage } from "./usage.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];
const SEP = "_";
const CACHE_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version",
};

const SERVER_INFO = {
  name: "allo-land",
  title: "Allo Land",
  version: "1.0.0",
  websiteUrl: "https://allo.land/",
};

export function createGateway(upstreams, { fetchImpl = fetch, now = Date.now } = {}) {
  const byPrefix = new Map(upstreams.map((u) => [u.prefix, u]));
  const cache = new Map(); // prefix -> { at, tools, instructions }
  let nextId = 1;

  async function rpc(upstream, method, params) {
    const body = { jsonrpc: "2.0", id: nextId++, method };
    if (params !== undefined) body.params = params;
    const res = await fetchImpl(upstream.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": LATEST,
        "user-agent": "allo-mcp-gateway/1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${upstream.title} answered HTTP ${res.status}`);
    const msg = await readMessage(res, body.id);
    if (msg.error) {
      const err = new Error(msg.error.message || `${upstream.title} returned an error`);
      err.rpc = msg.error;
      throw err;
    }
    return msg.result;
  }

  async function describe(upstream) {
    const hit = cache.get(upstream.prefix);
    if (hit && now() - hit.at < CACHE_MS) return hit;
    try {
      const [init, list] = await Promise.all([
        rpc(upstream, "initialize", {
          protocolVersion: LATEST,
          capabilities: {},
          clientInfo: { name: "allo-mcp-gateway", version: SERVER_INFO.version },
        }),
        listAllTools(upstream),
      ]);
      const entry = { at: now(), tools: list, instructions: init?.instructions || "" };
      cache.set(upstream.prefix, entry);
      return entry;
    } catch (e) {
      // Serve the last good copy if there is one, so one server being down
      // does not hide its tools for longer than it has to.
      if (hit) return hit;
      console.warn(`describe ${upstream.prefix} failed: ${e.message}`);
      return null;
    }
  }

  async function listAllTools(upstream) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc(upstream, "tools/list", cursor ? { cursor } : undefined);
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async function allTools() {
    const described = await Promise.all(upstreams.map(describe));
    const tools = [];
    described.forEach((d, i) => {
      if (!d) return;
      const u = upstreams[i];
      for (const t of d.tools) {
        tools.push({
          ...t,
          name: `${u.prefix}${SEP}${t.name}`,
          title: t.title ? `${u.title}: ${t.title}` : undefined,
          description: `[${u.title}] ${t.description || ""}`.trim(),
        });
      }
    });
    return tools;
  }

  async function instructions() {
    const described = await Promise.all(upstreams.map(describe));
    const parts = [
      "Allo Land (allo.land) brings together the Allo tools for families and newcomers in Germany. " +
        "Each tool name starts with the service it comes from: " +
        upstreams.map((u) => `${u.prefix}${SEP} = ${u.title} (${u.site})`).join(", ") +
        ". Follow each service's notes below.",
    ];
    described.forEach((d, i) => {
      if (d?.instructions) parts.push(`## ${upstreams[i].title} (tools ${upstreams[i].prefix}${SEP}*)\n${d.instructions}`);
    });
    return parts.join("\n\n");
  }

  function route(name) {
    const i = typeof name === "string" ? name.indexOf(SEP) : -1;
    if (i < 1) return null;
    const upstream = byPrefix.get(name.slice(0, i));
    return upstream ? { upstream, tool: name.slice(i + 1) } : null;
  }

  async function handleOne(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return errorReply(msg?.id ?? null, -32600, "Invalid Request");
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null; // notifications/initialized, cancelled, ...
    const { id, method, params } = msg;
    try {
      switch (method) {
        case "initialize": {
          const asked = params?.protocolVersion;
          return reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: await instructions(),
          });
        }
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, { tools: await allTools() });
        case "tools/call": {
          const r = route(params?.name);
          if (!r) return errorReply(id, -32602, `Unknown tool: ${params?.name}`);
          try {
            const result = await rpc(r.upstream, "tools/call", {
              ...params,
              name: r.tool,
            });
            return reply(id, result);
          } catch (e) {
            if (e.rpc) return { jsonrpc: "2.0", id, error: e.rpc };
            return reply(id, {
              isError: true,
              content: [{ type: "text", text: `${r.upstream.title} could not be reached: ${e.message}. Try again in a moment.` }],
            });
          }
        }
        case "resources/list":
          return reply(id, { resources: [] });
        case "prompts/list":
          return reply(id, { prompts: [] });
        default:
          return errorReply(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return errorReply(id, -32603, e.message || "Internal error");
    }
  }

  async function handle(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: SERVER_INFO.title,
        mcp: `${url.origin}/mcp`,
        services: upstreams.map((u) => ({ prefix: u.prefix, title: u.title, site: u.site })),
      });
    }
    if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404);
    if (request.method === "GET") {
      // Stateless server: no server-to-client stream.
      return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 405, headers: CORS });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: CORS });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(errorReply(null, -32700, "Parse error"), 400);
    }
    const msgs = Array.isArray(body) ? body : [body];
    const events = [];
    const answers = await Promise.all(
      msgs.map(async (msg) => {
        const start = now();
        const answer = await handleOne(msg);
        // Notifications and pings are not worth a log write.
        if (answer && msg?.method !== "ping") events.push(usageEvent({ msg, answer, ms: now() - start, route }));
        return answer;
      })
    );
    // Fire-and-forget data points; stored and exported once a day (src/usage.js, src/export.js).
    recordUsage({ request, env, events });
    const out = answers.filter(Boolean);
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  }

  return { handle, route };
}

// Read one JSON-RPC message from a JSON or text/event-stream response.
async function readMessage(res, id) {
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!type.includes("text/event-stream")) return JSON.parse(text);
  let found;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const m = JSON.parse(data);
      if (m.id === id && ("result" in m || "error" in m)) found = m;
    } catch {}
  }
  if (!found) throw new Error("No answer in event stream");
  return found;
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function errorReply(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
