// Daily export (cron in wrangler.toml): turns a day of Analytics Engine data points into
// one NDJSON file in R2 (logs/<YYYY-MM-DD>.ndjson) and sends the day's totals to the
// shared Allo usage counter. Runs in the background on its own schedule, never during a call.
//
// Each run exports yesterday (UTC) and any of the 7 days before it that has no file yet,
// so a missed run catches up. A day already in R2 is skipped, so it is never counted twice.
// Cost per day: 24 Analytics Engine read queries (free plan: 10,000 a day), one R2 write,
// a few R2 reads, and one counter call.
//
// Needs: binding LOGS (R2), binding COUNT (allo-count, entrypoint Counter), and secrets
// ACCOUNT_ID and AE_API_TOKEN (a token with Account Analytics: Read).

import { BLOBS, DATASET, DOUBLES, counterFeatures } from "./usage.js";

const DAY_MS = 86400000;
const ROWS_PER_HOUR = 10000;

export const dayKey = (day) => `logs/${day}.ndjson`;

export function daysToCheck(now = new Date(), back = 8) {
  const out = [];
  for (let i = back; i >= 1; i--) out.push(new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

const sqlTime = (d) => d.toISOString().slice(0, 19).replace("T", " ");

export function hourQuery(day, hour) {
  const from = new Date(`${day}T00:00:00Z`);
  from.setUTCHours(hour);
  const to = new Date(from.getTime() + 3600000);
  const cols = [
    "timestamp",
    "_sample_interval",
    ...BLOBS.map((_, i) => `blob${i + 1}`),
    ...DOUBLES.map((_, i) => `double${i + 1}`),
  ].join(", ");
  return `SELECT ${cols} FROM ${DATASET} WHERE timestamp >= toDateTime('${sqlTime(from)}') AND timestamp < toDateTime('${sqlTime(to)}') ORDER BY timestamp LIMIT ${ROWS_PER_HOUR} FORMAT JSON`;
}

// One Analytics Engine row -> one log line (empty fields left out).
export function toLine(row) {
  const line = { t: new Date(String(row.timestamp).replace(" ", "T") + "Z").toISOString() };
  BLOBS.forEach((k, i) => {
    const v = row[`blob${i + 1}`];
    if (v) line[k] = v;
  });
  line.ms = Number(row.double1) || 0;
  line.ok = Number(row.double2) === 1;
  const sample = Number(row._sample_interval) || 1;
  if (sample !== 1) line.sample = sample; // this line stands for `sample` requests
  return line;
}

export function dailyTotals(day, lines) {
  const totals = new Map();
  for (const line of lines) {
    for (const feature of counterFeatures(line)) {
      const key = `${feature}|${line.country || "XX"}`;
      totals.set(key, (totals.get(key) || 0) + (line.sample || 1));
    }
  }
  return [...totals].map(([key, n]) => {
    const [feature, country] = key.split("|");
    return { day, feature, country, n: Math.round(n) };
  });
}

async function query(env, sql, fetchImpl) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AE_API_TOKEN}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data || [];
}

export async function exportDay(env, day, fetchImpl = fetch) {
  const lines = [];
  let capped = false;
  for (let hour = 0; hour < 24; hour++) {
    const rows = await query(env, hourQuery(day, hour), fetchImpl);
    if (rows.length >= ROWS_PER_HOUR) capped = true;
    lines.push(...rows.map(toLine));
  }
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
  await env.LOGS.put(dayKey(day), body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { lines: String(lines.length), capped: String(capped) },
  });
  let counted = 0;
  if (typeof env.COUNT?.countMany === "function") {
    const rows = dailyTotals(day, lines);
    for (let i = 0; i < rows.length; i += 500) counted += await env.COUNT.countMany("mcp", rows.slice(i, i + 500));
  }
  return { day, lines: lines.length, counted, capped };
}

export async function runExport(env, { now = new Date(), fetchImpl = fetch } = {}) {
  if (String(env.USAGE || "").toLowerCase() === "off") return [];
  if (!env.LOGS || !env.ACCOUNT_ID || !env.AE_API_TOKEN) {
    console.warn("usage export skipped: LOGS, ACCOUNT_ID or AE_API_TOKEN missing");
    return [];
  }
  const done = [];
  for (const day of daysToCheck(now)) {
    if (await env.LOGS.head(dayKey(day))) continue;
    try {
      done.push(await exportDay(env, day, fetchImpl));
    } catch (e) {
      console.error(`usage export ${day} failed: ${e.message}`);
    }
  }
  return done;
}
