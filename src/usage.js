// Usage of the gateway, written once a day, never on the path of a call.
//
// During the day: each JSON-RPC request becomes one data point in Workers Analytics
// Engine (binding USAGE_AE, dataset allo_mcp_usage). writeDataPoint returns at once, does
// no I/O we wait for, and any error is swallowed, so it never blocks, slows or breaks a
// call. Analytics Engine keeps data points for 3 months; free plan: 100,000 a day.
//
// Once a day (src/export.js, cron): yesterday's points become one NDJSON file in the
// private R2 bucket allo-mcp-logs (logs/<YYYY-MM-DD>.ndjson), and their totals go to the
// shared Allo usage counter (monitoring.admin.allo.land, site "mcp").
//
// A data point holds (and nothing else): method, tool, service, the assistant's name and
// version, protocol version, first User-Agent token, country, error text, time taken,
// ok. Never an IP address, ID, cookie, tool arguments or anything from the answer.

export const DATASET = "allo_mcp_usage";

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

export function usageEvent({ msg, answer, ms, route }) {
  const ev = { method: typeof msg?.method === "string" ? cleanText(msg.method, 60) : "invalid" };
  const params = (msg && typeof msg.params === "object" && msg.params) || {};
  if (ev.method === "initialize") {
    const info = params.clientInfo || {};
    if (info.name) ev.client = cleanText(info.name, 60);
    if (info.version) ev.clientVersion = cleanText(info.version, 30);
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

// Column order in Analytics Engine. Never reorder: old points keep their positions.
export const BLOBS = ["method", "tool", "service", "client", "clientVersion", "proto", "ua", "country", "err"];
export const DOUBLES = ["ms", "ok"];

const userAgent = (request) => {
  const first = (request.headers.get("user-agent") || "").trim().split(/[\s(]/)[0];
  return first ? cleanText(first, 60) : "";
};

// Records the events of one request. Synchronous, never throws.
export function recordUsage({ request, env, events }) {
  try {
    if (!events.length || typeof env?.USAGE_AE?.writeDataPoint !== "function") return;
    if (String(env.USAGE || "").toLowerCase() === "off") return;
    const shared = {
      ua: userAgent(request),
      country: typeof request.cf?.country === "string" ? request.cf.country.slice(0, 2) : "",
    };
    for (const ev of events.slice(0, 100)) {
      const row = { ...ev, ...shared };
      try {
        env.USAGE_AE.writeDataPoint({
          indexes: [row.service || row.method],
          blobs: BLOBS.map((k) => String(row[k] ?? "")),
          doubles: [row.ms || 0, row.ok ? 1 : 0],
        });
      } catch {
        // ignore: usage must never break an answer
      }
    }
  } catch {
    // ignore
  }
}

// What the shared counter gets for one logged line.
export function counterFeatures(line) {
  const out = [];
  if (line.method === "initialize") out.push("session", `client_${clientKind(line.client)}`);
  if (line.method === "tools/call") {
    out.push(line.service && line.service !== "unknown" && /^[a-z0-9_]{1,43}$/.test(line.tool || "") ? `tool_${line.tool}` : "tool_unknown");
  }
  if (line.ok === false) out.push("error");
  return out;
}
