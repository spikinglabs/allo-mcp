import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";

const UP = [
  { prefix: "cars", title: "Allo Cars", url: "https://cars.test/mcp", site: "https://cars.test/" },
  { prefix: "outings", title: "Allo Outings", url: "https://outings.test/mcp", site: "https://outings.test/" },
];

function fakeFetch({ down = new Set(), sse = new Set(), calls = [] } = {}) {
  return async (url, init) => {
    const host = new URL(url).host.split(".")[0];
    const msg = JSON.parse(init.body);
    calls.push({ host, msg });
    if (down.has(host)) return new Response("down", { status: 502 });
    let result;
    if (msg.method === "initialize") result = { instructions: `${host} notes` };
    else if (msg.method === "tools/list") result = { tools: [{ name: "search", description: `${host} search`, inputSchema: { type: "object" } }] };
    else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad args" } });
      result = { content: [{ type: "text", text: `${host}:${msg.params.name}:${JSON.stringify(msg.params.arguments)}` }] };
    }
    const reply = { jsonrpc: "2.0", id: msg.id, result };
    if (sse.has(host)) {
      return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(reply);
  };
}

const post = (gw, body) =>
  gw.handle(new Request("https://mcp.allo.land/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("initialize merges instructions", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch() });
  const r = await (await post(gw, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.equal(r.result.serverInfo.name, "allo-land");
  assert.match(r.result.instructions, /cars notes/);
  assert.match(r.result.instructions, /outings notes/);
});

test("tools/list prefixes names and reads SSE answers", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ sse: new Set(["outings"]) }) });
  const r = await (await post(gw, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ["cars_search", "outings_search"]);
  assert.match(r.result.tools[0].description, /^\[Allo Cars\]/);
});

test("tools/call strips the prefix and routes", async () => {
  const calls = [];
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ calls }) });
  const r = await (await post(gw, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "outings_fetch_place", arguments: { id: "x" } } })).json();
  assert.equal(r.result.content[0].text, 'outings:fetch_place:{"id":"x"}');
  assert.equal(calls.at(-1).host, "outings");
});

test("unknown tool and upstream errors", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ down: new Set(["cars"]) }) });
  let r = await (await post(gw, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope_x" } })).json();
  assert.equal(r.error.code, -32602);
  r = await (await post(gw, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cars_search" } })).json();
  assert.equal(r.result.isError, true);
  r = await (await post(gw, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "outings_boom" } })).json();
  assert.equal(r.error.message, "bad args");
});

test("one server down still lists the other", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ down: new Set(["cars"]) }) });
  const r = await (await post(gw, { jsonrpc: "2.0", id: 7, method: "tools/list" })).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ["outings_search"]);
});

test("cache serves stale copy when a server goes down", async () => {
  let t = 0;
  const down = new Set();
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ down }), now: () => t });
  await post(gw, { jsonrpc: "2.0", id: 8, method: "tools/list" });
  down.add("cars");
  t = 10 * 60 * 1000;
  const r = await (await post(gw, { jsonrpc: "2.0", id: 9, method: "tools/list" })).json();
  assert.equal(r.result.tools.length, 2);
});

test("notifications get 202, batches work, GET is 405", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch() });
  assert.equal((await post(gw, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const b = await (await post(gw, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).json();
  assert.equal(b.length, 1);
  assert.equal((await gw.handle(new Request("https://mcp.allo.land/mcp"))).status, 405);
});

test("openapi.json lists every tool as POST /api/<tool>", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch() });
  const r = await (await gw.handle(new Request("https://mcp.allo.land/openapi.json"))).json();
  assert.equal(r.openapi, "3.1.0");
  assert.equal(r.servers[0].url, "https://mcp.allo.land");
  assert.deepEqual(Object.keys(r.paths), ["/api/cars_search", "/api/outings_search"]);
  const op = r.paths["/api/cars_search"].post;
  assert.equal(op.operationId, "cars_search");
  assert.equal(op["x-openai-isConsequential"], true); // no readOnlyHint in the fake
  assert.equal(op.requestBody.content["application/json"].schema.type, "object");
});

test("POST /api/<tool> calls the tool and returns its answer", async () => {
  const calls = [];
  const gw = createGateway(UP, { fetchImpl: fakeFetch({ calls }) });
  const res = await gw.handle(
    new Request("https://mcp.allo.land/api/outings_fetch", { method: "POST", body: JSON.stringify({ id: "x" }) }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { result: 'outings:fetch:{"id":"x"}' });
  assert.equal(calls.at(-1).host, "outings");
  let bad = await gw.handle(new Request("https://mcp.allo.land/api/nope_x", { method: "POST", body: "{}" }));
  assert.equal(bad.status, 404);
  bad = await gw.handle(new Request("https://mcp.allo.land/api/cars_search", { method: "POST", body: "[1]" }));
  assert.equal(bad.status, 400);
  bad = await gw.handle(new Request("https://mcp.allo.land/api/cars_boom", { method: "POST", body: "{}" }));
  assert.equal(bad.status, 400); // upstream JSON-RPC error
});

test("privacy page is served", async () => {
  const gw = createGateway(UP, { fetchImpl: fakeFetch() });
  const res = await gw.handle(new Request("https://mcp.allo.land/privacy"));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Allo Outings/);
});
