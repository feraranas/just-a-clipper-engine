import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  runClipSelectorSmoke,
  smokeFailureSummary,
} from "./clip-selector-smoke.mjs";
import {
  buildTranscriptJsonSchema,
  TRANSCRIPT_PROMPT,
} from "./clip-selection-contract.mjs";

const authorization = {
  AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE: "1",
  AUDIOGRAM_LLM_PROVIDER: "openai-api",
  OPENAI_API_KEY: "synthetic-never-sent",
};

const editorialChecks = {
  selfContained: true,
  hasSetupBeforeClaim: true,
  completeThought: true,
  substantiveInsight: true,
  containsSponsorOrCta: false,
};

const selection = (rank, firstCue, ideaKey) => {
  const cueId = (offset) => `c${String(firstCue + offset).padStart(6, "0")}`;
  return {
    rank,
    title: `A complete synthetic insight ${rank}`,
    ideaKey,
    startCueId: cueId(0),
    contextCueId: cueId(1),
    insightCueId: cueId(2),
    payoffCueId: cueId(3),
    endCueId: cueId(4),
    contextSummary:
      "The speaker establishes enough context for a new listener.",
    insightSummary: "The speaker states a substantive and nonobvious insight.",
    payoffSummary:
      "The speaker closes with a practical consequence or application.",
    score: 1 - rank / 10,
    editorialChecks,
  };
};

const parsedSelection = {
  clips: [
    selection(1, 1, "reduce-uncertainty"),
    selection(2, 6, "test-assumptions"),
    selection(3, 11, "compound-learning"),
  ],
};

test("unauthorized smoke exits before provider construction, credentials, or fetch", async () => {
  let providerConstructions = 0;
  let credentialReads = 0;
  let fetchCalls = 0;
  const lines = [];

  const result = await runClipSelectorSmoke({
    environment: {},
    print: (line) => lines.push(line),
    createProvider: () => {
      providerConstructions += 1;
      credentialReads += 1;
      fetchCalls += 1;
      throw new Error("must not construct provider");
    },
  });

  assert.deepEqual(result, { authorized: false });
  assert.deepEqual(lines, ["live smoke test not authorized"]);
  assert.equal(providerConstructions, 0);
  assert.equal(credentialReads, 0);
  assert.equal(fetchCalls, 0);
});

test("authorized smoke requires an explicit provider and official API key before network", async () => {
  let providerConstructions = 0;
  let fetchCalls = 0;
  const options = {
    print: () => {},
    createProvider: () => {
      providerConstructions += 1;
      return {
        generateStructured: async () => {
          fetchCalls += 1;
        },
      };
    },
  };

  await assert.rejects(
    runClipSelectorSmoke({
      ...options,
      environment: { AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE: "1" },
    }),
    /AUDIOGRAM_LLM_PROVIDER/,
  );
  await assert.rejects(
    runClipSelectorSmoke({
      ...options,
      environment: {
        AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE: "1",
        AUDIOGRAM_LLM_PROVIDER: "openai-api",
      },
    }),
    /OPENAI_API_KEY/,
  );
  assert.equal(providerConstructions, 0);
  assert.equal(fetchCalls, 0);
});

test("authorized OAuth smoke requires dedicated credentials before network", async (t) => {
  const directory = await fs.mkdtemp(
    "/private/tmp/audiogram-selector-smoke-auth-",
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let fetchCalls = 0;

  await assert.rejects(
    runClipSelectorSmoke({
      environment: {
        AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE: "1",
        AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
        AUDIOGRAM_CHATGPT_AUTH_PATH: join(directory, "missing-auth.json"),
      },
      print: () => {},
      providerDependencies: {
        projectRoot: process.cwd(),
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("network must not run without credentials");
        },
      },
    }),
    { code: "provider_request_failed" },
  );
  assert.equal(fetchCalls, 0);
});

test("authorized smoke exercises the production request contract and prints only a safe summary", async () => {
  const requests = [];
  const lines = [];
  const result = await runClipSelectorSmoke({
    environment: authorization,
    print: (line) => lines.push(line),
    createProvider: (config) => ({
      providerId: config.providerId,
      model: config.model,
      async generateStructured(request) {
        requests.push(request);
        return {
          parsed: parsedSelection,
          provenance: {
            providerId: config.providerId,
            model: config.model,
            recipeSha256:
              "e7a70b34898cca39e4a0db0708daaada9ee6290fe7a6a25726fec6a1408273a9",
            responseId: "resp_smoke_synthetic",
          },
        };
      },
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].instructions, TRANSCRIPT_PROMPT);
  assert.deepEqual(requests[0].jsonSchema, buildTranscriptJsonSchema(3));
  const transcript = JSON.parse(requests[0].input);
  assert.equal(transcript.source, "synthetic-smoke");
  assert.equal(transcript.language, "en");
  assert.equal(transcript.cues.length, 15);
  assert.deepEqual(
    result.clips.map(({ startMs, endMs }) => ({ startMs, endMs })),
    [
      { startMs: 0, endMs: 40_750 },
      { startMs: 58_500, endMs: 100_750 },
      { startMs: 118_500, endMs: 160_000 },
    ],
  );

  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(summary, {
    providerId: "openai-api",
    model: "gpt-5.6-terra",
    recipeSha256:
      "e7a70b34898cca39e4a0db0708daaada9ee6290fe7a6a25726fec6a1408273a9",
    responseId: "resp_smoke_synthetic",
    schemaVersion: 1,
    clipCount: 3,
    status: "pass",
  });
  assert.deepEqual(Object.keys(summary), [
    "providerId",
    "model",
    "recipeSha256",
    "responseId",
    "schemaVersion",
    "clipCount",
    "status",
  ]);
  assert.doesNotMatch(lines[0], /synthetic-never-sent|speaker|title|summary/);
});

test("failure summaries expose only the seven approved fields", () => {
  assert.deepEqual(smokeFailureSummary({ AUDIOGRAM_LLM_PROVIDER: "other" }), {
    providerId: null,
    model: "gpt-5.6-terra",
    recipeSha256: null,
    responseId: null,
    schemaVersion: 1,
    clipCount: 0,
    status: "fail",
  });
});
