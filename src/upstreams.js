// Every Allo MCP server the gateway fronts. Adding a server is one entry here.
// `prefix` goes in front of each of its tool names (cars_get_recalls), so it must
// stay short, lower case and unique, and never change once people use it.
export const UPSTREAMS = [
  {
    prefix: "cars",
    title: "Allo Cars",
    url: "https://cars.allo.land/mcp",
    site: "https://cars.allo.land/",
  },
  {
    prefix: "outings",
    title: "Allo Outings",
    url: "https://outings.allo.land/mcp",
    site: "https://outings.allo.land/",
  },
];
