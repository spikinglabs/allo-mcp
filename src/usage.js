// Usage of the gateway: daily counts and a raw log, both written in the background
// (ctx.waitUntil) after the answer has gone out, so they never block or slow a call.
// Any failure here is swallowed: logging must never break an answer.
//
// 1. Counts, on the shared Allo usage counter (monitoring.admin.allo.land, site "mcp"),
//    over the COUNT service binding to the allo-count Worker (spikinglabs/alloland-rebirth,
//    workers/count). Per day and country: "session" when an assistant connects,
//    "client_<name>" for which assistant, "tool_<prefix>_<name>" per tool call, "error".
//
// 2. A raw log in the R2 bucket bound as LOGS: one small NDJSON object per POST,
//    logs/<YYYY-MM-DD>/<HHMMSSmmm>-<random>.ndjson, one line per JSON-RPC message:
//      t, method, tool, service, client {name, version}, proto, ua (first product token),
//      country, ms, ok, err
//    Never: IP address, session or user ID, cookies, tool arguments, or anything from the answer.
//
// Free-tier budget: one R2 write per POST against 1 million writes a month for the whole account
// (shared with the Allo Cars MCP log). To stop both counts and logs, set USAGE = "off" in wrangler.toml.

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function cleanText(value, max = 80) {
  return String(value ?? "")
    .slice(0, 200)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\d{6,}/g, "[number]")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}

// Which assistant connected, from the name it sends with initialize. Coarse on purpose.
const CLIENTS = [
  [/claude[-_ ]?code/i, "claude_code"],
  [/claude|anthropic/i, "claude"],
  [/openai|chatgpt/i, "chatgpt"],
  [/cursor/i, "cursor"],
  [/windsurf|codeium/i, "windsurf"],
  [/copilot|vscode|visual studio/i, "vscode"],
  [/gemini|google/i, "gemini"],
  [/mistral|le ?chat/i, "mistral"],
  [/perplexity/i, "perplexity"],
  [/inspector/i, "inspector"],
];
export function clientKind(name) {
  if (!name) return "unknown";
  for (const [re, kind] of CLIENTS) if (re.test(name)) return kind;
  return "other";
}

export function usageEvent({ msg, answer, ms, route, at = new Date() }) {
  const ev = { t: at.toISOString(), method: typeof msg?.method === "string" ? cleanText(msg.method, 60) : "invalid" };
  const params = (msg && typeof msg.params === "object" && msg.params) || {};
  if (ev.method === "initialize") {
    const info = params.clientInfo || {};
    if (info.name) ev.client = { name: cleanText(info.name, 60), version: info.version ? cleanText(info.version, 30) : undefined };
    if (params.protocolVersion) ev.proto = cleanText(params.protocolVersion, 20);
  }
  if (ev.method === "tools/call") {
    const r = route(params.name);
    ev.tool = r ? `${r.upstream.prefix}_${r.tool}` : cleanText(params.name, 60) || "missing";
    ev.service = r ? r.upstream.prefix : "unknown";
  }
  ev.ms = Math.max(0, Math.round(ms));
  if (answer?.error) {
    ev.ok = false;
    ev.err = `rpc ${answer.error.code}`;
  } else if (answer?.result?.isError) {
    ev.ok = false;
    ev.err = cleanText(answer.result.content?.[0]?.text || "tool error", 120);
  } else {
    ev.ok = true;
  }
  return ev;
}

export function counterFeatures(ev) {
  const out = [];
  if (ev.method === "initialize") out.push("session", `client_${clientKind(ev.client?.name)}`);
  // Only real tool names become counter rows, so junk names can't fill the table.
  if (ev.method === "tools/call") out.push(ev.service !== "unknown" && /^[a-z0-9_]{1,43}$/.test(ev.tool || "") ? `tool_${ev.tool}` : "tool_unknown");
  if (ev.ok === false) out.push("error");
  return out;
}

export function logKey(at = new Date(), rand = Math.random) {
  const day = at.toISOString().slice(0, 10);
  const time = pad(at.getUTCHours()) + pad(at.getUTCMinutes()) + pad(at.getUTCSeconds()) + pad(at.getUTCMilliseconds(), 3);
  return `logs/${day}/${time}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}.ndjson`;
}

const userAgent = (request) => {
  const first = (request.headers.get("user-agent") || "").trim().split(/[\s(]/)[0];
  return first ? cleanText(first, 60) : undefined;
};

// Starts the writes in the background. Never throws and never awaits on the answer's path.
export function saveUsage({ request, env, ctx, events, at = new Date() }) {
  try {
    const lines = events.filter(Boolean);
    if (!lines.length || !env || String(env.USAGE || "").toLowerCase() === "off") return;
    const cc = typeof request.cf?.country === "string" ? request.cf.country.slice(0, 2) : undefined;
    const shared = { ua: userAgent(request), country: cc };
    const jobs = [];
    if (typeof env.LOGS?.put === "function") {
      const body = lines.map((ev) => JSON.stringify({ ...ev, ...shared })).join("\n") + "\n";
      jobs.push(() => env.LOGS.put(logKey(at), body, { httpMetadata: { contentType: "application/x-ndjson" } }));
    }
    if (typeof env.COUNT?.count === "function") {
      for (const f of lines.flatMap(counterFeatures)) jobs.push(() => env.COUNT.count("mcp", f, cc || "XX"));
    }
    const all = Promise.allSettled(jobs.map((job) => Promise.resolve().then(job)));
    ctx?.waitUntil?.(all);
  } catch {
    // ignore: logging must never break an answer
  }
}
