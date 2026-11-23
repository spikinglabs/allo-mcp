import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import { clientKind, counterFeatures, usageEvent, BLOBS } from "../src/usage.js";

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
function fakeEnv({ throws = false } = {}) {
  const points = [];
  return {
    env: { USAGE_AE: { writeDataPoint: (p) => { if (throws) throw new Error("boom"); points.push(p); } } },
    points,
  };
}
const asRow = (p) => Object.fromEntries(BLOBS.map((k, i) => [k, p.blobs[i]]));

test("clientKind is coarse", () => {
  assert.equal(clientKind("claude-ai"), "claude");
  assert.equal(clientKind("claude-code"), "claude_code");
  assert.equal(clientKind("openai-mcp"), "chatgpt");
  assert.equal(clientKind("Cursor"), "cursor");
  assert.equal(clientKind("my-own-thing"), "other");
  assert.equal(clientKind(undefined), "unknown");
});

test("a tool call becomes one data point, without its arguments, and no storage write", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  const res = await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search", arguments: { query: "me@x.de" } } }), f.env, {});
  assert.equal((await res.json()).result.content[0].text, "ok");
  assert.equal(f.points.length, 1);
  const row = asRow(f.points[0]);
  assert.equal(row.tool, "outings_search");
  assert.equal(row.service, "outings");
  assert.equal(row.country, "AT");
  assert.equal(row.ua, "Claude-User/1.0");
  assert.equal(f.points[0].doubles[1], 1);
  assert.ok(!JSON.stringify(f.points).includes("me@x.de"));
});

test("initialize records the assistant", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-ai", version: "0.1" } } }, {}), f.env, {});
  const row = asRow(f.points[0]);
  assert.equal(row.client, "claude-ai");
  assert.equal(row.clientVersion, "0.1");
  assert.equal(row.country, "");
});

test("notifications and pings record nothing", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  assert.equal((await gw.handle(req({ jsonrpc: "2.0", method: "notifications/initialized" }), f.env, {})).status, 202);
  await gw.handle(req({ jsonrpc: "2.0", id: 2, method: "ping" }), f.env, {});
  assert.equal(f.points.length, 0);
});

test("a throwing recorder, or none at all, never breaks the answer", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  for (const env of [fakeEnv({ throws: true }).env, {}, undefined, { USAGE_AE: null }]) {
    const res = await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search" } }), env, undefined);
    assert.equal(res.status, 200);
  }
});

test("USAGE=off records nothing; unknown tools count as tool_unknown", async () => {
  const gw = createGateway(UP, { fetchImpl: upstream });
  const f = fakeEnv();
  await gw.handle(req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outings_search" } }), { ...f.env, USAGE: "off" }, {});
  assert.equal(f.points.length, 0);
  const ev = usageEvent({ msg: { method: "tools/call", params: { name: "nope_x" } }, answer: { error: { code: -32602 } }, ms: 3, route: () => null });
  assert.deepEqual(counterFeatures(ev), ["tool_unknown", "error"]);
  assert.deepEqual(counterFeatures({ method: "initialize", client: "openai-mcp", ok: true }), ["session", "client_chatgpt"]);
});
