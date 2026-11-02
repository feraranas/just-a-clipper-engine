#!/usr/bin/env node
// mcp-modern.mjs URL [TOOL [JSON_ARGS]] — connect to a running Audiogram MCP server with the repo's
// pinned modern SDK client (protocol 2026-07-28), print the negotiated era, discovered capabilities and
// tool names, then optionally call one tool and print its result as JSON.
// Imports resolve from the checkout's node_modules (Node follows this file's real path).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const [url, tool, args = "{}"] = process.argv.slice(2);
if (!url) { console.error("usage: mcp-modern.mjs URL [TOOL [JSON_ARGS]]"); process.exit(2); }
const client = new Client({ name: "verify-clipper", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
let code = 0;
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  console.log(JSON.stringify({ era: client.getProtocolEra(), capabilities: client.getServerCapabilities?.() ?? null }));
  console.log(JSON.stringify({ tools: (await client.listTools()).tools.map((t) => t.name) }));
  if (tool) {
    const result = await client.callTool({ name: tool, arguments: JSON.parse(args) });
    console.log(JSON.stringify(result));
    if (result.isError) code = 1;
  }
} catch (error) { console.error(`mcp-modern: ${error.message}`); code = 1; }
finally { await client.close().catch(() => {}); }
process.exit(code);
