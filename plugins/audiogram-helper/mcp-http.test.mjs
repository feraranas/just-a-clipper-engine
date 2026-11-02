import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { startMcpServer } from "./server.mjs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHttpHandler } from "./mcp-http.mjs";
import { z } from "zod";
import { URL } from "node:url";
import { setTimeout } from "node:timers";

const { fetch } = globalThis;

const runner = {
  start: async () => assert.fail("protocol verification must not start jobs"),
  getStatus: async () => null,
  retry: async () => assert.fail("protocol verification must not retry jobs"),
};
const params = (extra = {}) => ({
  ...extra,
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "protocol-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
});
async function rpc(url, method, input = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": input.name } : {}),
      ...(method === "resources/read" ? { "Mcp-Name": input.uri } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params(input),
    }),
  });
  const text = await response.text();
  const data = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .at(-1)
        ?.slice(6)
    : text;
  return { status: response.status, body: JSON.parse(data) };
}

test("modern discovery advertises the supported protocol without premature Events capability", async (t) => {
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  t.after(() => server.close());
  const { status, body } = await rpc(server.url, "server/discover");
  assert.equal(status, 200);
  assert.ok(
    body.result?.supportedVersions.includes("2026-07-28"),
    JSON.stringify(body),
  );
  assert.equal(body.result.capabilities.events, undefined);
});

test("modern requests can list tools and read the existing template preview resource", async (t) => {
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  t.after(() => server.close());
  const tools = (await rpc(server.url, "tools/list")).body.result;
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "create_audiogram",
    "get_audiogram_status",
    "list_video_templates",
    "retry_audiogram",
  ]);
  const listing = (
    await rpc(server.url, "tools/call", {
      name: "list_video_templates",
      arguments: {},
    })
  ).body.result;
  assert.equal(listing.structuredContent.templates[0].name, "Classic V1");
  const resources = (await rpc(server.url, "resources/list")).body.result;
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "ui://video-templates/v1.html",
    ),
  );
  const resource = (
    await rpc(server.url, "resources/read", {
      uri: "ui://video-templates/v1.html",
    })
  ).body.result;
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /<script>/);
  const unsupported = await rpc(server.url, "events/subscribe", {});
  assert.equal(unsupported.body.error.code, -32601);
});

test("HTTP guards reject oversized requests and wrong paths before MCP dispatch", async (t) => {
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  t.after(() => server.close());
  const response = await fetch(server.url, {
    method: "POST",
    body: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  const wrongPath = await fetch(`${server.url}/other`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(wrongPath.status, 404);
});

test("an explicitly configured principal resolver rejects unauthorized discovery", async (t) => {
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
    principalResolver: async () => null,
  });
  t.after(() => server.close());
  const response = await rpc(server.url, "server/discover");
  assert.equal(response.status, 403);
});

test("a pinned modern SDK client negotiates and calls the existing preview tool", async (t) => {
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  const client = new Client(
    { name: "modern-client", version: "1.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  assert.equal(client.getProtocolEra(), "modern");
  const listing = await client.callTool({
    name: "list_video_templates",
    arguments: {},
  });
  assert.equal(listing.structuredContent.templates[0].name, "Classic V1");
});

test("request cleanup closes MCP instances without mixing concurrent trusted principals", async (t) => {
  let created = 0;
  let closed = 0;
  const handler = createMcpHttpHandler({
    principalResolver: async (req) => {
      // This test-only resolver represents authentication performed upstream.
      const principal = req.headers["test-principal"];
      await new Promise((resolve) =>
        setTimeout(resolve, principal === "alpha" ? 10 : 1),
      );
      return principal ? { id: principal } : null;
    },
    makeServer: ({ principal }) => {
      created += 1;
      const server = new McpServer({
        name: "lifecycle-fixture",
        version: "1.0.0",
      });
      server.server.onclose = () => {
        closed += 1;
      };
      server.registerTool(
        "identity",
        { inputSchema: z.object({}) },
        async () => ({
          content: [{ type: "text", text: principal.id }],
        }),
      );
      return server;
    },
  });
  const http = createServer((req, res) => handler.handleNodeRequest(req, res));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await handler.close();
    await new Promise((resolve) => http.close(resolve));
  });
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  const identities = await Promise.all(
    ["alpha", "beta"].map(async (principal) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "identity",
          "test-principal": principal,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: params({
            name: "identity",
            arguments: {},
            principal: "forged",
          }),
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result.content[0].text;
    }),
  );
  assert.deepEqual(identities, ["alpha", "beta"]);
  assert.equal(created, 2);
  assert.equal(closed, 2);
  // An individual request did not close the shared handler: a third request works.
  const denied = await rpc(url, "server/discover");
  assert.equal(denied.status, 403);
  assert.equal(created, 2);
});
