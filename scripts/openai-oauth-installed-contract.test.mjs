import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Server } from "node:net";
import test from "node:test";
import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { createBoundedAllowlistedFetch } from "./bounded-fetch.mjs";
import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
  buildTranscriptZodSchema,
} from "./clip-selection-contract.mjs";
import { extractStructuredOutput } from "./structured-response.mjs";
import { deriveClipSelections } from "./transcript-selector.mjs";

const transcript = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/transcript-selection-adversarial.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const { validResponse } = transcript;
assert.equal(validResponse.clips.length, 3);
buildTranscriptZodSchema(3).parse(validResponse);
deriveClipSelections(
  validResponse,
  transcript,
  buildSelectionRecipe({
    selectorId: "transcript-llm",
    providerId: "chatgpt-oauth",
    desiredClipCount: 3,
  }).recipe,
);
const validJson = JSON.stringify(validResponse);
const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
const message = {
  type: "message",
  id: "msg_1",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", annotations: [], text: validJson }],
};
const sse = (items) =>
  [
    ...items.flatMap((item, output_index) => [
      "event: response.output_item.done",
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}`,
      "",
    ]),
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", created_at: 1735689600, model: "gpt-5.6-terra", status: "completed", output: [], usage: { input_tokens: 200, output_tokens: 800, total_tokens: 1000 } } })}`,
    "",
    "",
  ].join("\n");
const run = async (items, requests) => {
  const transport = createOpenAIOAuthTransport({
    auth: async () => ({
      accessToken: "synthetic-access",
      accountId: "synthetic-account",
      isFedRamp: false,
    }),
    baseURL: "https://chatgpt.com/backend-api/codex",
    codexVersion: "0.144.1",
    responsesState: false,
    fetch: createBoundedAllowlistedFetch({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/models?"))
          return Response.json({
            models: [
              {
                slug: "gpt-5.6-terra",
                visibility: "list",
                supported_in_api: true,
                use_responses_lite: false,
              },
            ],
          });
        return new Response(sse(items), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }),
  });
  const client = new OpenAI({
    apiKey: "unused-placeholder",
    baseURL: transport.baseURL,
    fetch: transport.fetch,
    maxRetries: 0,
    timeout: 120000,
    logLevel: "off",
  });
  const format = {
    name: "transcript_clip_selection",
    type: "json_schema",
    strict: true,
    schema: buildTranscriptJsonSchema(3),
  };
  const result = await client.responses.create({
    model: "gpt-5.6-terra",
    instructions: "select",
    input: [{ type: "item_reference", id: "msg_previous" }],
    previous_response_id: "resp_previous",
    store: true,
    max_output_tokens: 4096,
    text: { format },
  });
  return { result, format };
};
test("installed core plus real SDK preserves schema and reconstructs reasoning/message SSE without replay or registry/proxy", async () => {
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = () => assert.fail("No proxy/server may start");
  try {
    const requests = [];
    const { result, format } = await run([reasoning, message], requests);
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].url,
      "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1",
    );
    assert.equal(
      requests[1].url,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const body = JSON.parse(requests[1].init.body);
    assert.deepEqual(body.text.format, format);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.previous_response_id, "resp_previous");
    assert.deepEqual(body.input, [
      { type: "item_reference", id: "msg_previous" },
    ]);
    assert.deepEqual(result.output, [reasoning, message]);
    // SDK may add its convenience accessor; the adapter must not rely on it.
    delete result.output_text;
    assert.equal(Object.hasOwn(result, "output_text"), false);
    const extracted = extractStructuredOutput(result, {
      desiredClipCount: 3,
      maximumOutputTextUtf8Bytes: 262144,
    });
    assert.deepEqual(extracted.parsed, validResponse);
    assert.equal(extracted.parsed.clips.length, 3);
    assert.equal(extracted.responseId, "resp_1");
  } finally {
    Server.prototype.listen = originalListen;
  }
});
for (const [name, items] of [
  [
    "refusal",
    [{ ...message, content: [{ type: "refusal", refusal: "synthetic" }] }],
  ],
  ["multiple messages", [message, { ...message, id: "msg_2" }]],
  [
    "multiple text items",
    [{ ...message, content: [...message.content, ...message.content] }],
  ],
  [
    "function call",
    [
      message,
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "tool",
        arguments: "{}",
      },
    ],
  ],
  ["unknown output", [message, { type: "unknown_future_output", id: "unk_1" }]],
])
  test(`installed SSE reconstruction reaches local rejection for ${name}`, async () => {
    const { result } = await run([reasoning, ...items], []);
    assert.throws(() =>
      extractStructuredOutput(result, {
        desiredClipCount: 3,
        maximumOutputTextUtf8Bytes: 262144,
      }),
    );
  });
