import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import { clientKind, counterFeatures, logKey, usageEvent } from "../src/usage.js";

const UP = [{ prefix: "outings", title: "Allo Outings", url: "https://outings.test/mcp", site: "https://outings.test/" }];
const upstream = async (_url, init) => {
  const msg = JSON.parse(init.body);
  const result = msg.method === "tools/list" ? { tools: [] } : msg.method === "initialize" ? {} : { content: [{ type: "text", text: "ok" }] };
  return Response.json({ jsonrpc: "2.0", id: msg.id, result });
};
const req = (body, cf = { country: "AT" }) => {
  const r = new Request("https://mcp.allo.land/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Claude-User/1.0 (+x)" },
    body: JSON.stringify(body),
  });
  Object.defineProperty(r, "cf", { value: cf });
  return r;
};
function fakeEnv({ hang = false, fail = false } = {}) {
  const puts = [], counts = [], waits = [];
  const slow = () => (hang ? new Promise(() => {}) : fail ? Promise.reject(new Error("down")) : Promise.resolve());
  return {
    env: {
      LOGS: { put: (k, b) => (puts.push([k, b]), slow()) },
      COUNT: { count: (...a) => (counts.push(a), slow()) },
    },
    ctx: { waitUntil: (p) => waits.push(p) },
    puts, counts, waits,
  };
}

test("clientKind is coarse", () => {
  assert.equal(clientKind("claude-ai"), "claude");
  assert.equal(clientKind("claude-code"), "claude_code");
  assert.equal(clientKind("openai-mcp"), "chatgpt");
  assert.equal(clientKind("Cursor"), "cursor");
  assert.equal(clientKind("my-own-thing"), "other");
  assert.equal(clientKind(undefined), "unknown");
});

test("a tool call is logged and counted without its arguments", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  const res = await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search", arguments: { query: "me@x.de" } } }), f.env, f.ctx);
  assert.equal((await res.json()).result.content[0].text, "ok");
  await Promise.all(f.waits);
  assert.equal(f.puts.length, 1);
  assert.match(f.puts[0][0], /^logs\/\d{4}-\d{2}-\d{2}\/\d{9}-[0-9a-z]{6}\.ndjson$/);
  const line = JSON.parse(f.puts[0][1]);
  assert.equal(line.tool, "outings_search");
  assert.equal(line.service, "outings");
  assert.equal(line.country, "AT");
  assert.equal(line.ua, "Claude-User/1.0");
  assert.equal(line.ok, true);
  assert.ok(!f.puts[0][1].includes("me@x.de"));
  assert.deepEqual(f.counts, [["mcp", "tool_outings_search", "AT"]]);
});

test("initialize counts the session and the assistant", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-ai", version: "0.1" } } }, {}), f.env, f.ctx);
  await Promise.all(f.waits);
  assert.deepEqual(f.counts.map((c) => c[1]), ["session", "client_claude"]);
  assert.equal(f.counts[0][2], "XX");
});

test("notifications write nothing", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  const res = await gw.handle(req({ jsonrpc: "2.0", method: "notifications/initialized" }), f.env, f.ctx);
  assert.equal(res.status, 202);
  assert.equal(f.puts.length + f.counts.length, 0);
});

test("a hanging or failing logger never blocks or breaks the answer", async () => {
  for (const opts of [{ hang: true }, { fail: true }]) {
    const gw = createGateway(UP, { fetchImpl: upstream });
    const f = fakeEnv(opts);
    const res = await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search" } }), f.env, f.ctx);
    assert.equal(res.status, 200);
  }
  const gw = createGateway(UP, { fetchImpl: upstream });
  const broken = { LOGS: { put: () => { throw new Error("sync boom"); } } };
  const res = await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "ping" }), broken, undefined);
  assert.equal(res.status, 200);
  const res2 = await gw.handle(req({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "outings_search" } }), broken, undefined);
  assert.equal(res2.status, 200);
});

test("USAGE=off stops everything; errors are counted", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search" } }), { ...f.env, USAGE: "off" }, f.ctx);
  assert.equal(f.puts.length + f.counts.length, 0);
  const ev = usageEvent({ msg: { method: "tools/call", params: { name: "nope_x" } }, answer: { error: { code: -32602 } }, ms: 3, route: () => null });
  assert.deepEqual(counterFeatures(ev), ["tool_unknown", "error"]);
  assert.match(logKey(new Date("2026-11-23T01:02:03.004Z"), () => 0), /^logs\/2026-11-23\/010203004-000000\.ndjson$/);
});
