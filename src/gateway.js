// Allo MCP gateway: one Streamable HTTP MCP endpoint (stateless, JSON responses)
// that lists the tools of every Allo MCP server under a prefix and passes each
// call through to the server that owns the tool.

import { usageEvent, recordUsage } from "./usage.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];
const SEP = "_";
const CACHE_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const API_MAX_CHARS = 90_000; // GPT Actions reject answers over ~100k characters

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
          annotations: annotate(t, u),
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

  // Plain HTTP API over the same tools, for clients that speak OpenAPI instead
  // of MCP (ChatGPT GPT Actions and similar). POST /api/<tool> with the tool's
  // arguments as the JSON body; GET /openapi.json describes every tool.
  async function openapi(origin) {
    const tools = await allTools();
    const paths = {};
    for (const t of tools) {
      const readOnly = t.annotations?.readOnlyHint === true;
      paths[`/api/${t.name}`] = {
        post: {
          operationId: t.name,
          summary: clip(t.annotations?.title || t.title || t.name, 120),
          description: clip(t.description || "", 300),
          "x-openai-isConsequential": !readOnly,
          requestBody: {
            required: true,
            content: { "application/json": { schema: openapiSchema(t.inputSchema) } },
          },
          responses: {
            200: {
              description: "The tool's answer. `result` holds its data; `error` is set when the tool could not answer.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ToolAnswer" } } },
            },
          },
        },
      };
    }
    return {
      openapi: "3.1.0",
      info: {
        title: "Allo Land",
        version: SERVER_INFO.version,
        description:
          "Open data for families and drivers in Germany from Allo Cars (cars.allo.land) and Allo Outings (outings.allo.land). " +
          "Free, no sign-in. The same tools as the MCP server at " + origin + "/mcp.",
      },
      servers: [{ url: origin }],
      paths,
      components: {
        schemas: {
          ToolAnswer: {
            type: "object",
            properties: {
              result: { description: "The tool's data (JSON when the tool returns JSON, otherwise text)." },
              error: { type: "string" },
            },
          },
        },
      },
    };
  }

  async function callApi(name, args) {
    const r = route(name);
    if (!r) return json({ error: `Unknown tool: ${name}` }, 404);
    try {
      const result = await rpc(r.upstream, "tools/call", { name: r.tool, arguments: args });
      const text = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (result?.isError) return json({ error: text || "The tool could not answer." });
      let data = result?.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      let body = JSON.stringify({ result: data });
      if (body.length > API_MAX_CHARS) {
        body = JSON.stringify({ result: clip(text || JSON.stringify(data), API_MAX_CHARS - 200), truncated: true });
      }
      return new Response(body, {
        headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (e) {
      if (e.rpc) return json({ error: e.rpc.message || "Bad request" }, 400);
      return json({ error: `${r.upstream.title} could not be reached: ${e.message}. Try again in a moment.` }, 502);
    }
  }

  async function handle(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/openapi.json" && request.method === "GET") return json(await openapi(url.origin));
    if (url.pathname === "/privacy" && request.method === "GET") return privacyPage(upstreams);
    if (url.pathname === "/terms" && request.method === "GET") return termsPage(upstreams);
    if (url.pathname === "/.well-known/openai-apps-challenge" && request.method === "GET") {
      // Domain check for the ChatGPT plugin directory: the token goes in wrangler.toml [vars].
      const token = String(env?.OPENAI_APPS_CHALLENGE || "").trim();
      return token
        ? new Response(token, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })
        : json({ error: "Not found" }, 404);
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
      let args = {};
      const raw = await request.text();
      if (raw.trim()) {
        try {
          args = JSON.parse(raw);
        } catch {
          return json({ error: "Body must be JSON" }, 400);
        }
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) return json({ error: "Body must be a JSON object" }, 400);
      const name = decodeURIComponent(url.pathname.slice(5));
      const start = now();
      const res = await callApi(name, args);
      // Counted like an MCP tools/call, with client "openapi" (no arguments, no answer).
      const ev = usageEvent({
        msg: { method: "tools/call", params: { name } },
        answer: res.ok ? {} : { error: { code: res.status } },
        ms: now() - start,
        route,
      });
      ev.client = "openapi";
      recordUsage({ request, env, events: [ev] });
      return res;
    }
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: SERVER_INFO.title,
        mcp: `${url.origin}/mcp`,
        openapi: `${url.origin}/openapi.json`,
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

function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// MCP input schemas are JSON Schema; OpenAPI 3.1 takes them as they are, but
// GPT Actions want an object schema with properties.
function openapiSchema(schema) {
  const s = schema && typeof schema === "object" ? { ...schema } : {};
  delete s.$schema;
  if (!s.type) s.type = "object";
  if (!s.properties) s.properties = {};
  return s;
}

// Every tool carries explicit readOnlyHint, destructiveHint and openWorldHint (app
// directories require all three) and a title. A server's own values win; the gateway
// fills only what is missing: read-only tools are not destructive, and the Allo
// servers answer from their own catalogue, so openWorldHint defaults to false.
export function annotate(tool, upstream) {
  const a = { ...(tool.annotations || {}) };
  const readOnly = a.readOnlyHint === true;
  if (typeof a.readOnlyHint !== "boolean") a.readOnlyHint = false;
  if (typeof a.destructiveHint !== "boolean") a.destructiveHint = readOnly ? false : true;
  if (typeof a.openWorldHint !== "boolean") a.openWorldHint = false;
  if (!a.title) a.title = upstream.titles?.[tool.name] || tool.title || undefined;
  if (!a.title) delete a.title;
  return a;
}

const PAGE_STYLE =
  "body{font:16px/1.55 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#211e1c;background:#fff8ee}a{color:#c4521f}h2{font-size:1.1rem;margin-top:1.6rem}";
const page = (title, body) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`,
    { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } }
  );

// Privacy note for the gateway itself, linked from app directories. Keep it in step
// with src/usage.js: it must name every field a usage data point holds.
function privacyPage(upstreams) {
  const links = upstreams.map((u) => `<li><a href="${u.site}">${u.title}</a></li>`).join("");
  return page(
    "Allo Land MCP: privacy",
    `<h1>Allo Land MCP and API: privacy</h1>
<p>mcp.allo.land is a free gateway, run by SpikingLabs, to the Allo services listed below. It needs no account and sets no cookies.</p>
<h2>What we receive and why</h2>
<p>Your assistant sends us the tool it wants to use and that tool's arguments, for example a town and a date. We pass them to the Allo service that owns the tool and return its answer. We do not store the arguments or the answers.</p>
<h2>What we keep</h2>
<p>For each request we keep one usage record, so we can see which tools are used and fix errors: the method and tool name, which service answered, the assistant's name and version, the protocol version, the first word of the user agent, the country (from our host, not from you), the error text if any, the time taken, and whether it worked. We never keep IP addresses, account or device IDs, cookies, tool arguments or answers.</p>
<p>Usage records are held in Cloudflare Analytics Engine for up to 3 months and copied once a day into a private storage bucket in the EU. Daily totals go to our own usage counter. Our host, Cloudflare, also keeps short-lived technical logs to run the service.</p>
<h2>Who else receives data</h2>
<ul><li>The Allo service that answers a request receives its arguments. Each service's own policy covers what it does with them:<ul>${links}</ul></li>
<li>Cloudflare hosts the gateway and its storage.</li>
<li>Suggestions, tips and problem reports for Allo Outings are sent only when you ask your assistant to send them. A moderator reviews them before anything is published.</li></ul>
<p>We do not sell data or use it for advertising.</p>
<h2>Your choices</h2>
<p>You can stop using the gateway at any time by removing it from your assistant. Because usage records hold nothing that identifies you, we cannot find or delete one person's records. For questions, use the contact details in the imprint on <a href="https://allo.land/">allo.land</a> or open an issue on <a href="https://github.com/spikinglabs/allo-mcp/issues">GitHub</a>.</p>`
  );
}

function termsPage(upstreams) {
  const links = upstreams.map((u) => `<a href="${u.site}">${u.title}</a>`).join(", ");
  return page(
    "Allo Land MCP: terms",
    `<h1>Allo Land MCP and API: terms of use</h1>
<p>mcp.allo.land is a free service run by SpikingLabs that gives AI assistants access to open data from ${links}. No account is needed.</p>
<ul><li>The data comes from public and official sources and from organisers' listings. Times, prices and ratings can change and can be wrong. Check the linked source page before you rely on it.</li>
<li>Nothing here is legal, financial, medical or safety advice. Recalls for one specific car depend on its VIN; ask the manufacturer.</li>
<li>Use it fairly: no automated bulk downloading and no attempts to overload or break the service. We may limit or block traffic that harms it.</li>
<li>Suggestions you send are reviewed by a moderator, who may edit or decline them. Send only what you have the right to share, and no personal data about others.</li>
<li>The service is provided as it is, without guarantees, and may change or stop at any time. As far as the law allows, we are not liable for decisions made on its answers.</li></ul>
<p>Questions: see the imprint on <a href="https://allo.land/">allo.land</a>. Privacy: <a href="/privacy">mcp.allo.land/privacy</a>.</p>`
  );
}
