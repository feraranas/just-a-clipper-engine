import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpServer } from "./server.mjs";
test("actual MCP discovery exposes scene blocks and forwards exact approval identity", async () => {
  let received;
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    port: 0,
    runner: {},
    explainerRunner: {
      run: async (args) => {
        received = args;
        return { state: "script_approved", revision: 3 };
      },
    },
  });
  const client = new Client({ name: "explainer-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "continue_explainer"));
    const blocks = await client.callTool({
      name: "list_scene_blocks",
      arguments: {},
    });
    assert.equal(JSON.parse(blocks.content[0].text).length, 3);
    const args = {
      reviewId: "51f94a9c-c63e-4d11-8a73-03a3bfe7afdc",
      action: "approve_script",
      revision: 2,
      hash: "exact-script",
    };
    const result = await client.callTool({
      name: "continue_explainer",
      arguments: args,
    });
    assert.deepEqual(received, args);
    assert.equal(result.structuredContent.revision, 3);
  } finally {
    await client.close();
    await server.close();
  }
});
