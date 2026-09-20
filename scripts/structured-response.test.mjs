import assert from "node:assert/strict";
import test from "node:test";

import { extractStructuredOutput } from "./structured-response.mjs";

const checks = {
  selfContained: true,
  hasSetupBeforeClaim: true,
  completeThought: true,
  substantiveInsight: true,
  containsSponsorOrCta: false,
};
const clip = (rank) => ({
  rank,
  title: `Complete useful idea ${rank}`,
  ideaKey: `useful-idea-${rank}`,
  startCueId: `c${String(rank * 5 - 4).padStart(6, "0")}`,
  contextCueId: `c${String(rank * 5 - 3).padStart(6, "0")}`,
  insightCueId: `c${String(rank * 5 - 2).padStart(6, "0")}`,
  payoffCueId: `c${String(rank * 5 - 1).padStart(6, "0")}`,
  endCueId: `c${String(rank * 5).padStart(6, "0")}`,
  contextSummary: "Enough context for a new listener",
  insightSummary: "A substantive and nonobvious insight",
  payoffSummary: "A clear application of the insight",
  score: 1 - rank / 10,
  editorialChecks: checks,
});
const validJson = JSON.stringify({ clips: [clip(1), clip(2), clip(3)] });
const response = (overrides = {}) => ({
  id: "resp_123",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_123", summary: [] },
    {
      type: "message",
      id: "msg_123",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text: validJson }],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 340,
    total_tokens: 460,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 100 },
  },
  ...overrides,
});
const limits = { desiredClipCount: 3, maximumOutputTextUtf8Bytes: 24_576 };

test("walks official-style output and allowlists numeric provenance", () => {
  const result = extractStructuredOutput(response(), limits);
  assert.equal(result.responseId, "resp_123");
  assert.equal(result.parsed.clips.length, 3);
  assert.deepEqual(result.usage, response().usage);
  assert.equal("output_text" in response(), false);

  const noisy = response({
    usage: {
      ...response().usage,
      secret: "drop",
      input_tokens_details: { cached_tokens: 20, other: 9 },
      output_tokens_details: { reasoning_tokens: 100, other: 8 },
    },
  });
  assert.deepEqual(
    extractStructuredOutput(noisy, limits).usage,
    response().usage,
  );
});

test("rejects incomplete, refused, ambiguous, tool, and unknown envelopes", () => {
  const message = response().output[1];
  for (const candidate of [
    response({ status: "incomplete" }),
    response({ output: [{ ...message, status: "incomplete" }] }),
    response({ output: [] }),
    response({ output: [message, message] }),
    response({ output: [{ ...message, role: "user" }] }),
    response({ output: [{ ...message, content: [] }] }),
    response({
      output: [
        {
          ...message,
          content: [...message.content, { ...message.content[0] }],
        },
      ],
    }),
    response({
      output: [{ ...message, content: [{ type: "refusal", refusal: "No" }] }],
    }),
    response({ output: [{ type: "function_call", name: "x" }, message] }),
    response({ output: [{ type: "tool_call", name: "x" }, message] }),
    response({ output: [{ type: "mystery" }, message] }),
  ])
    assert.throws(() => extractStructuredOutput(candidate, limits));
});

test("rejects conflicting convenience text, malformed/oversize/schema-invalid JSON", () => {
  assert.throws(() =>
    extractStructuredOutput(response({ output_text: "different" }), limits),
  );
  assert.equal(
    extractStructuredOutput(response({ output_text: validJson }), limits).parsed
      .clips.length,
    3,
  );
  const message = response().output[1];
  const withText = (text) =>
    response({
      output: [{ ...message, content: [{ ...message.content[0], text }] }],
    });
  assert.throws(() => extractStructuredOutput(withText("{"), limits));
  assert.throws(() =>
    extractStructuredOutput(withText("😀".repeat(6_145)), limits),
  );
  assert.throws(() =>
    extractStructuredOutput(withText(JSON.stringify({ clips: [] })), limits),
  );
  assert.throws(() =>
    extractStructuredOutput(
      response({ usage: { ...response().usage, total_tokens: NaN } }),
      limits,
    ),
  );
});
