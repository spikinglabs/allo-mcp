// Runs the gateway in Node against the live Allo MCP servers.
import { createGateway } from "../src/gateway.js";
import { UPSTREAMS } from "../src/upstreams.js";

const gw = createGateway(UPSTREAMS);
const call = async (body) =>
  (await gw.handle(new Request("https://mcp.allo.land/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).json();

const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
console.log("instructions chars:", init.result.instructions.length);
const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
console.log("tools:", list.result.tools.map((t) => t.name).join(", "));
const a = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cars_get_fuel_prices", arguments: {} } });
console.log("cars_get_fuel_prices:", JSON.stringify(a).slice(0, 300));
const b = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "outings_search", arguments: { query: "playground", city: "Köln" } } });
console.log("outings_search:", JSON.stringify(b).slice(0, 300));
