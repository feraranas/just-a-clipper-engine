import test from "node:test";
import assert from "node:assert/strict";
import { registerCandidateReviewTools } from "./candidate-review-tools.mjs";

test("review tools pass exact selection and status arguments without triggering preparation", async () => {
  const registered = new Map();
  let prepares = 0;
  const chosen = {
    reviewId: "123",
    state: "selected",
    selection: "candidate-2",
  };
  registerCandidateReviewTools(
    {
      registerTool: (name, options, handler) =>
        registered.set(name, { options, handler }),
    },
    {
      prepare: async () => {
        prepares++;
        return { state: "preparing" };
      },
      get: async () => chosen,
      select: async (args) => {
        assert.equal(args.reviewHash, "hash");
        assert.equal(args.candidateId, "candidate-2");
        return chosen;
      },
    },
  );
  assert.equal(registered.size, 3);
  assert.throws(() =>
    registered
      .get("prepare_candidate_review")
      .options.inputSchema.parse({
        url: "https://youtube.com",
        requestId: "bad",
      }),
  );
  const result = await registered
    .get("select_candidate_review")
    .handler({
      reviewId: "123",
      reviewHash: "hash",
      candidateId: "candidate-2",
    });
  assert.equal(result.structuredContent.selection, "candidate-2");
  assert.equal(prepares, 0);
});

import { startMcpServer } from "./server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("actual MCP connection retrieves a review and saves explicit selection", async () => {
  const reviewId = "51f94a9c-c63e-4d11-8a73-03a3bfe7afdc";
  let selected = null;
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    port: 0,
    runner: {},
    candidateRunner: {
      get: async () => ({
        reviewId,
        state: "awaiting_selection",
        selection: selected,
        review: {
          candidates: [
            {
              candidateId: "candidate-1",
              title: "Caching",
              evidence: [{ text: "A cache stores reusable results." }],
            },
          ],
        },
      }),
      select: async (args) => {
        assert.equal(args.reviewHash, "hash");
        selected = args.candidateId;
        return { reviewId, state: "selected", selection: selected };
      },
      prepare: async () => {
        throw Error("Read must not prepare");
      },
    },
  });
  const client = new Client({ name: "candidate-review-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const result = await client.callTool({
      name: "get_candidate_review",
      arguments: { reviewId },
    });
    assert.equal(
      result.structuredContent.review.candidates[0].title,
      "Caching",
    );
    const choice = await client.callTool({
      name: "select_candidate_review",
      arguments: { reviewId, reviewHash: "hash", candidateId: "candidate-1" },
    });
    assert.equal(choice.structuredContent.selection, "candidate-1");
  } finally {
    await client.close();
    await server.close();
  }
});
