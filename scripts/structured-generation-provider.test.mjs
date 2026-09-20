import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  buildTranscriptJsonSchema,
  TRANSCRIPT_LIMITS,
  TRANSCRIPT_PROMPT,
} from "./clip-selection-contract.mjs";
import { createStructuredGenerationProvider } from "./structured-generation-provider.mjs";
import { writeCredentialsAtomically } from "./chatgpt-oauth-credentials.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";

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
const officialResponse = {
  id: "resp_test_123",
  object: "response",
  created_at: 1_735_689_600,
  model: "gpt-5.6-terra",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_test_123", summary: [] },
    {
      type: "message",
      id: "msg_test_123",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text: validJson }],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 340,
    total_tokens: 460,
    input_tokens_details: { cached_tokens: 20, secret_detail: "drop" },
    output_tokens_details: { reasoning_tokens: 100, other: 8 },
    raw_secret: "drop",
  },
  raw_secret: "drop",
};

const config = (environment = {}, providerId = "openai-api") =>
  resolveSelectionConfig({
    AUDIOGRAM_CLIP_SELECTOR: "transcript-llm",
    AUDIOGRAM_LLM_PROVIDER: providerId,
    OPENAI_API_KEY: "configuration-validation-only",
    ...environment,
  });
const request = (overrides = {}) => ({
  instructions: TRANSCRIPT_PROMPT,
  input: '{"source":"creator-en","language":"en","cues":[]}',
  jsonSchema: buildTranscriptJsonSchema(3),
  ...overrides,
});
const jsonResponse = (body = officialResponse, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const oauthFixture = async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/audiogram-provider-oauth-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, "project");
  const authFile = join(directory, "credentials", "auth.json");
  await fs.mkdir(projectRoot);
  const now = () => Date.parse("2026-09-20T12:00:00.000Z");
  await writeCredentialsAtomically(
    {
      schemaVersion: 1,
      auth_mode: "chatgpt",
      tokens: {
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        account_id: "synthetic-account",
      },
      last_refresh: "2026-09-20T12:00:00.000Z",
      access_expires_at: null,
      is_fedramp: false,
    },
    { authFile, projectRoot, now },
  );
  return { authFile, projectRoot, now };
};

const oauthSseResponse = (response = officialResponse) => {
  const lines = response.output.flatMap((item, output_index) => [
    "event: response.output_item.done",
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}`,
    "",
  ]);
  lines.push(
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response: { ...response, output: [] } })}`,
    "",
    "",
  );
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/event-stream" },
  });
};

test("requires an explicit official API key before any fetch", () => {
  let fetchCalls = 0;
  assert.throws(
    () =>
      createStructuredGenerationProvider(config(), {
        environment: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse();
        },
      }),
    /OPENAI_API_KEY is required/,
  );
  assert.equal(fetchCalls, 0);
});

test("uses the real SDK with one locked official request and returns sanitized provenance", async () => {
  const seen = [];
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    environment: { OPENAI_BASE_URL: "https://attacker.invalid/v9" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse();
    },
  });

  assert.deepEqual(
    { providerId: provider.providerId, model: provider.model },
    { providerId: "openai-api", model: "gpt-5.6-terra" },
  );
  const result = await provider.generateStructured(request());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.openai.com/v1/responses");
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("x-stainless-timeout"), "120");
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    model: "gpt-5.6-terra",
    store: false,
    max_output_tokens: 4096,
    instructions: request().instructions,
    input: request().input,
    text: {
      format: {
        name: "transcript_clip_selection",
        type: "json_schema",
        schema: request().jsonSchema,
        strict: true,
      },
    },
  });
  assert.equal(result.parsed.clips.length, 3);
  assert.deepEqual(Object.keys(result).sort(), ["parsed", "provenance"]);
  assert.deepEqual(Object.keys(result.provenance).sort(), [
    "model",
    "providerId",
    "recipeSha256",
    "responseId",
    "usage",
  ]);
  assert.deepEqual(result.provenance, {
    providerId: "openai-api",
    model: "gpt-5.6-terra",
    responseId: "resp_test_123",
    recipeSha256:
      "e7a70b34898cca39e4a0db0708daaada9ee6290fe7a6a25726fec6a1408273a9",
    usage: {
      input_tokens: 120,
      output_tokens: 340,
      total_tokens: 460,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 100 },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /raw_secret|secret_detail/);
});

test("uses app-owned credentials with the bounded in-process OAuth transport", async (t) => {
  const credentials = await oauthFixture(t);
  const seen = [];
  const provider = createStructuredGenerationProvider(
    config({}, "chatgpt-oauth"),
    {
      ...credentials,
      environment: { OPENAI_API_KEY: "must-not-be-used" },
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
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
        return oauthSseResponse();
      },
    },
  );

  const result = await provider.generateStructured(request());

  assert.deepEqual(
    { providerId: provider.providerId, model: provider.model },
    { providerId: "chatgpt-oauth", model: "gpt-5.6-terra" },
  );
  assert.equal(seen.length, 2);
  assert.equal(
    seen[0].url,
    "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1",
  );
  assert.equal(seen[1].url, "https://chatgpt.com/backend-api/codex/responses");
  const body = JSON.parse(seen[1].init.body);
  assert.equal(body.model, "gpt-5.6-terra");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
  assert.deepEqual(body.text.format, {
    name: "transcript_clip_selection",
    type: "json_schema",
    schema: request().jsonSchema,
    strict: true,
  });
  assert.equal(result.parsed.clips.length, 3);
  assert.equal(result.provenance.providerId, "chatgpt-oauth");
  assert.equal(result.provenance.model, "gpt-5.6-terra");
});

test("OAuth rejects every caller-owned provider override before credentials or network", async () => {
  let fetchCalls = 0;
  const provider = createStructuredGenerationProvider(
    config({}, "chatgpt-oauth"),
    {
      authFile: "/synthetic/outside-project/auth.json",
      projectRoot: "/synthetic/project",
      fetch: async () => {
        fetchCalls += 1;
        return oauthSseResponse();
      },
    },
  );
  for (const extra of [
    { model: "other" },
    { store: true },
    { max_output_tokens: 1 },
    { endpoint: "https://attacker.invalid" },
    { apiKey: "other" },
    { headers: { authorization: "Bearer other" } },
    { format: { strict: false } },
    { strict: false },
    { text: { format: { strict: false } } },
  ])
    await assert.rejects(
      provider.generateStructured(request(extra)),
      /Unknown structured generation argument/,
    );
  assert.equal(fetchCalls, 0);
});

test("OAuth surfaces a swallowed catalog body timeout and makes no Responses call", async (t) => {
  const credentials = await oauthFixture(t);
  let deadline;
  let fetchCalls = 0;
  let headersReturned;
  const didReturnHeaders = new Promise((resolve) => {
    headersReturned = resolve;
  });
  const provider = createStructuredGenerationProvider(
    config({}, "chatgpt-oauth"),
    {
      ...credentials,
      scheduler: {
        setTimeout(callback, milliseconds) {
          assert.equal(milliseconds, 30_000);
          deadline = callback;
          return "catalog-deadline";
        },
        clearTimeout(handle) {
          assert.equal(handle, "catalog-deadline");
        },
      },
      fetch: async () => {
        fetchCalls++;
        headersReturned();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"models":['));
            },
          }),
        );
      },
    },
  );

  const pending = provider.generateStructured(request());
  await didReturnHeaders;
  await new Promise((resolve) => setImmediate(resolve));
  deadline();
  await assert.rejects(pending, { code: "oauth_catalog_timeout" });
  assert.equal(fetchCalls, 1);
});

test("rejects every caller-owned provider override before fetch", async () => {
  let fetchCalls = 0;
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse();
    },
  });
  for (const extra of [
    { model: "other" },
    { store: true },
    { max_output_tokens: 1 },
    { endpoint: "https://attacker.invalid" },
    { apiKey: "other" },
    { headers: { authorization: "Bearer other" } },
    { format: { strict: false } },
    { strict: false },
    { text: { format: { strict: false } } },
  ]) {
    await assert.rejects(
      provider.generateStructured(request(extra)),
      /Unknown structured generation argument/,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("rejects instructions or schema that do not match the precomputed recipe before fetch", async () => {
  let fetchCalls = 0;
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse();
    },
  });
  const changedSchema = structuredClone(request().jsonSchema);
  changedSchema.properties.clips.minItems = 2;

  await assert.rejects(
    provider.generateStructured(
      request({ instructions: `${TRANSCRIPT_PROMPT}\nchanged` }),
    ),
    /instructions do not match the configured selection recipe/,
  );
  await assert.rejects(
    provider.generateStructured(request({ jsonSchema: changedSchema })),
    /jsonSchema does not match the configured selection recipe/,
  );
  assert.equal(fetchCalls, 0);
});

test("rejects recipe limits that disagree with provider-owned hard caps", () => {
  for (const limits of [
    {
      ...TRANSCRIPT_LIMITS,
      officialMaximumOutputTokens:
        TRANSCRIPT_LIMITS.officialMaximumOutputTokens - 1,
    },
    {
      ...TRANSCRIPT_LIMITS,
      maximumOutputTextUtf8Bytes:
        TRANSCRIPT_LIMITS.maximumOutputTextUtf8Bytes + 1,
    },
  ]) {
    const changedConfig = structuredClone(config());
    changedConfig.limits = limits;
    assert.throws(
      () =>
        createStructuredGenerationProvider(changedConfig, {
          apiKey: "sk-test-provider-key-not-real",
          fetch: async () => jsonResponse(),
        }),
      /Official structured provider configuration is invalid/,
    );
  }
});

test("captures immutable recipe validation values at provider creation", async () => {
  const mutableConfig = structuredClone(config());
  const provider = createStructuredGenerationProvider(mutableConfig, {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () => jsonResponse(),
  });

  mutableConfig.desiredClipCount = 5;
  mutableConfig.limits.maximumOutputTextUtf8Bytes = 1;
  const result = await provider.generateStructured(request());

  assert.equal(result.parsed.clips.length, 3);
  assert.equal(
    result.provenance.recipeSha256,
    "e7a70b34898cca39e4a0db0708daaada9ee6290fe7a6a25726fec6a1408273a9",
  );
});

test("rejects a signal without cleanup support before fetch", async () => {
  let fetchCalls = 0;
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse();
    },
  });

  await assert.rejects(
    provider.generateStructured(
      request({ signal: { aborted: false, addEventListener() {} } }),
    ),
    /signal must be an AbortSignal/,
  );
  assert.equal(fetchCalls, 0);
});

test("disables SDK retries and never exposes raw provider failures", async () => {
  let fetchCalls = 0;
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(
        { error: { message: "upstream sk-proj-raw-secret" } },
        500,
      );
    },
  });

  await assert.rejects(provider.generateStructured(request()), (error) => {
    assert.equal(error.providerId, "openai-api");
    assert.equal(error.code, "provider_request_failed");
    assert.equal(error.httpStatus, 500);
    assert.doesNotMatch(String(error), /raw-secret/);
    assert.equal("request" in error, false);
    assert.equal("response" in error, false);
    return true;
  });
  assert.equal(fetchCalls, 1);
});

test("keeps the provider deadline armed through stalled response-body parsing", async () => {
  let fireDeadline;
  let cleared = false;
  let headersReturned;
  const didReturnHeaders = new Promise((resolve) => {
    headersReturned = resolve;
  });
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    scheduler: {
      setTimeout(callback, milliseconds) {
        assert.equal(milliseconds, 120_000);
        fireDeadline = callback;
        return "deadline-handle";
      },
      clearTimeout(handle) {
        assert.equal(handle, "deadline-handle");
        cleared = true;
      },
    },
    fetch: async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"resp_stalled"'));
          init.signal.addEventListener(
            "abort",
            () => controller.error(init.signal.reason),
            { once: true },
          );
        },
      });
      headersReturned();
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const pending = provider.generateStructured(request());
  await didReturnHeaders;
  assert.equal(cleared, false);
  fireDeadline();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "provider_timeout");
    return true;
  });
  assert.equal(cleared, true);
});

test("omits an unsafe provider response ID from provenance", async () => {
  const provider = createStructuredGenerationProvider(config(), {
    apiKey: "sk-test-provider-key-not-real",
    fetch: async () =>
      jsonResponse({
        ...officialResponse,
        id: `resp_${"x".repeat(600)}\nraw-secret`,
      }),
  });

  const result = await provider.generateStructured(request());
  assert.equal("responseId" in result.provenance, false);
  assert.doesNotMatch(JSON.stringify(result), /raw-secret/);
});

test("ignores ambient SDK debug logging so raw provider data cannot be logged", async () => {
  const previousLogLevel = process.env.OPENAI_LOG;
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const logged = [];
  process.env.OPENAI_LOG = "debug";
  for (const level of Object.keys(originalConsole))
    console[level] = (...values) => logged.push({ level, values });

  try {
    const provider = createStructuredGenerationProvider(config(), {
      apiKey: "sk-test-provider-key-not-real",
      fetch: async () => jsonResponse(),
    });
    await provider.generateStructured(request());
  } finally {
    for (const [level, implementation] of Object.entries(originalConsole))
      console[level] = implementation;
    if (previousLogLevel === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousLogLevel;
  }

  assert.deepEqual(logged, []);
});
