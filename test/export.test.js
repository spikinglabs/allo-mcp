import { test } from "node:test";
import assert from "node:assert/strict";
import { daysToCheck, hourQuery, toLine, dailyTotals, runExport, dayKey } from "../src/export.js";

const NOW = new Date("2026-11-24T01:20:00Z");

test("checks the last 8 days, oldest first", () => {
  const d = daysToCheck(NOW);
  assert.equal(d.length, 8);
  assert.equal(d[0], "2026-11-16");
  assert.equal(d.at(-1), "2026-11-23");
});

test("hour query covers one UTC hour", () => {
  const q = hourQuery("2026-11-23", 13);
  assert.match(q, /FROM allo_mcp_usage/);
  assert.match(q, /toDateTime\('2026-11-23 13:00:00'\)/);
  assert.match(q, /toDateTime\('2026-11-23 14:00:00'\)/);
  assert.match(q, /FORMAT JSON$/);
});

const row = (o = {}) => ({
  timestamp: "2026-11-23 13:05:00", _sample_interval: 1,
  blob1: "tools/call", blob2: "outings_search", blob3: "outings", blob4: "", blob5: "", blob6: "", blob7: "Claude-User/1.0", blob8: "DE", blob9: "",
  double1: 120, double2: 1, ...o,
});

test("rows become lines and daily totals", () => {
  const l = toLine(row());
  assert.deepEqual(l, { t: "2026-11-23T13:05:00.000Z", method: "tools/call", tool: "outings_search", service: "outings", ua: "Claude-User/1.0", country: "DE", ms: 120, ok: true });
  const lines = [l, toLine(row({ _sample_interval: 3 })), toLine(row({ blob1: "initialize", blob2: "", blob3: "", blob4: "claude-ai", blob8: "", double2: 0, blob9: "rpc -1" }))];
  const totals = dailyTotals("2026-11-23", lines);
  const get = (f, c) => totals.find((t) => t.feature === f && t.country === c)?.n;
  assert.equal(get("tool_outings_search", "DE"), 4);
  assert.equal(get("session", "XX"), 1);
  assert.equal(get("client_claude", "XX"), 1);
  assert.equal(get("error", "XX"), 1);
});

function fakeEnv(existing = []) {
  const objects = new Map(existing.map((d) => [dayKey(d), ""]));
  const counted = [];
  return {
    env: {
      ACCOUNT_ID: "acc", AE_API_TOKEN: "tok",
      LOGS: { head: async (k) => (objects.has(k) ? {} : null), put: async (k, b) => objects.set(k, b) },
      COUNT: { countMany: async (site, rows) => (counted.push([site, rows]), rows.length) },
    },
    objects, counted,
  };
}

test("exports missing days once, writing one file per day", async () => {
  const f = fakeEnv(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
  let queries = 0;
  const fetchImpl = async (url, init) => {
    queries++;
    assert.match(url, /accounts\/acc\/analytics_engine\/sql$/);
    assert.equal(init.headers.Authorization, "Bearer tok");
    return Response.json({ data: init.body.includes(">= toDateTime('2026-11-23 13:00:00')") ? [row()] : [] });
  };
  const done = await runExport(f.env, { now: NOW, fetchImpl });
  assert.equal(queries, 24);
  assert.deepEqual(done, [{ day: "2026-11-23", lines: 1, counted: 1, capped: false }]);
  assert.equal(f.objects.get("logs/2026-11-23.ndjson").trim().split("\n").length, 1);
  assert.deepEqual(f.counted[0][1], [{ day: "2026-11-23", feature: "tool_outings_search", country: "DE", n: 1 }]);
  // A second run finds nothing to do.
  assert.deepEqual(await runExport(f.env, { now: NOW, fetchImpl }), []);
});

test("a failing day is left for the next run; missing secrets skip quietly", async () => {
  const f = fakeEnv(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
  const done = await runExport(f.env, { now: NOW, fetchImpl: async () => new Response("nope", { status: 500 }) });
  assert.deepEqual(done, []);
  assert.equal(f.objects.has("logs/2026-11-23.ndjson"), false);
  assert.deepEqual(await runExport({ LOGS: f.env.LOGS }, { now: NOW }), []);
});
