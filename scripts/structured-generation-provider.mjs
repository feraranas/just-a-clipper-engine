import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";

import { createBoundedAllowlistedFetch } from "./bounded-fetch.mjs";
import { canonicalJson, sha256Canonical } from "./canonical-json.mjs";
import { loadFreshChatGptSession } from "./chatgpt-oauth-credentials.mjs";
import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
  OAUTH_CODEX_VERSION,
  SELECTOR_MODEL,
  TRANSCRIPT_LIMITS,
} from "./clip-selection-contract.mjs";
import { SafeDiagnosticError } from "./error-diagnostics.mjs";
import {
  extractStructuredOutput,
  InvalidSelectionOutputError,
} from "./structured-response.mjs";

const OFFICIAL_PROVIDER_ID = "openai-api";
const OAUTH_PROVIDER_ID = "chatgpt-oauth";
const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OFFICIAL_TIMEOUT_MS = 120_000;
const OAUTH_SDK_TIMEOUT_MS = 125_000;
const FORMAT_NAME = "transcript_clip_selection";
const generateKeys = new Set(["instructions", "input", "jsonSchema", "signal"]);
const dependencyKeys = new Set([
  "apiKey",
  "environment",
  "fetch",
  "scheduler",
  "authFile",
  "projectRoot",
  "now",
]);
const schedulerKeys = new Set(["setTimeout", "clearTimeout"]);
const defaultScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};
const silentSdkLogger = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
});

const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new Error(`Unknown ${label} argument: ${String(key)}`);
  }
};

const apiKeyFrom = (dependencies) => {
  const hasExplicitKey = Object.hasOwn(dependencies, "apiKey");
  const value = hasExplicitKey
    ? dependencies.apiKey
    : (dependencies.environment ?? process.env).OPENAI_API_KEY;
  if (typeof value !== "string" || !value.trim())
    throw new Error("OPENAI_API_KEY is required for openai-api");
  return value;
};

const validateSignal = (signal) => {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw new Error("signal must be an AbortSignal");
};

const validateRequest = (request) => {
  exactKeys(request, generateKeys, "structured generation");
  if (typeof request.instructions !== "string" || !request.instructions)
    throw new Error("instructions must be a nonempty string");
  if (typeof request.input !== "string" || !request.input)
    throw new Error("input must be a nonempty string");
  if (
    !request.jsonSchema ||
    typeof request.jsonSchema !== "object" ||
    Array.isArray(request.jsonSchema)
  )
    throw new Error("jsonSchema must be a plain JSON object");
  validateSignal(request.signal);
  return JSON.parse(canonicalJson(request.jsonSchema));
};

const safeResponseId = (value) =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") <= 512 &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ? value
    : undefined;

const safeHttpStatus = (error) =>
  Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status
    : undefined;

const createProvider = (config, dependencies = {}, task = null) => {
  exactKeys(dependencies, dependencyKeys, "provider dependency");
  const providerId = config?.providerId;
  const invalidConfigurationMessage =
    providerId === OFFICIAL_PROVIDER_ID
      ? "Official structured provider configuration is invalid"
      : providerId === OAUTH_PROVIDER_ID
        ? "ChatGPT OAuth structured provider configuration is invalid"
        : "Structured provider configuration is invalid";
  if (
    !config ||
    ![OFFICIAL_PROVIDER_ID, OAUTH_PROVIDER_ID].includes(providerId) ||
    config.model !== SELECTOR_MODEL ||
    (providerId === OAUTH_PROVIDER_ID &&
      config.codexVersion !== OAUTH_CODEX_VERSION)
  )
    throw new Error(invalidConfigurationMessage);
  if (
    dependencies.environment !== undefined &&
    (!dependencies.environment ||
      typeof dependencies.environment !== "object" ||
      Array.isArray(dependencies.environment))
  )
    throw new Error("environment must be an object");
  if (
    dependencies.fetch !== undefined &&
    typeof dependencies.fetch !== "function"
  )
    throw new Error("fetch must be a function");
  for (const key of ["authFile", "projectRoot"])
    if (
      dependencies[key] !== undefined &&
      (typeof dependencies[key] !== "string" || !dependencies[key])
    )
      throw new Error(`${key} must be a nonempty string`);
  if (dependencies.now !== undefined && typeof dependencies.now !== "function")
    throw new Error("now must be a function");
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  exactKeys(scheduler, schedulerKeys, "scheduler");
  if (
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  )
    throw new Error("scheduler must provide setTimeout and clearTimeout");

  const apiKey =
    providerId === OFFICIAL_PROVIDER_ID
      ? apiKeyFrom(dependencies)
      : "unused-oauth-placeholder";
  const selectionRecipe = buildSelectionRecipe(config);
  const { recipe } = selectionRecipe;
  const recipeSha256 = task
    ? sha256Canonical({
        name: task.name,
        instructions: task.instructions,
        jsonSchema: task.jsonSchema,
      })
    : selectionRecipe.sha256;
  if (
    recipe.limits.officialMaximumOutputTokens !==
      TRANSCRIPT_LIMITS.officialMaximumOutputTokens ||
    recipe.limits.maximumOutputTextUtf8Bytes >
      TRANSCRIPT_LIMITS.maximumOutputTextUtf8Bytes
  )
    throw new Error(invalidConfigurationMessage);
  const expectedInstructionsSha256 = task
    ? sha256Canonical(task.instructions)
    : recipe.prompt.sha256;
  const expectedJsonSchemaSha256 = task
    ? sha256Canonical(task.jsonSchema)
    : recipe.outputSchema.sha256;
  const desiredClipCount = recipe.desiredClipCount;
  const maximumOutputTextUtf8Bytes = recipe.limits.maximumOutputTextUtf8Bytes;
  const officialClient =
    providerId === OFFICIAL_PROVIDER_ID
      ? new OpenAI({
          apiKey,
          adminAPIKey: null,
          organization: null,
          project: null,
          webhookSecret: null,
          baseURL: OFFICIAL_BASE_URL,
          maxRetries: 0,
          timeout: OFFICIAL_TIMEOUT_MS,
          logLevel: "off",
          logger: silentSdkLogger,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        })
      : undefined;

  return {
    providerId,
    model: SELECTOR_MODEL,
    async generateStructured(request) {
      const jsonSchema = validateRequest(request);
      if (sha256Canonical(request.instructions) !== expectedInstructionsSha256)
        throw new Error(
          "Structured generation instructions do not match the configured selection recipe",
        );
      if (sha256Canonical(jsonSchema) !== expectedJsonSchemaSha256)
        throw new Error(
          "Structured generation jsonSchema does not match the configured selection recipe",
        );
      const transcript = JSON.parse(request.input);
      const boundSchema =
        task?.jsonSchema ??
        buildTranscriptJsonSchema(
          desiredClipCount,
          transcript.cues?.map((cue) => cue.id) ?? [],
        );
      const body = {
        model: SELECTOR_MODEL,
        store: false,
        ...(providerId === OFFICIAL_PROVIDER_ID
          ? {
              max_output_tokens: TRANSCRIPT_LIMITS.officialMaximumOutputTokens,
            }
          : {}),
        instructions: request.instructions,
        input: request.input,
        text: {
          format: {
            name: task?.name ?? FORMAT_NAME,
            type: "json_schema",
            schema: boundSchema,
            strict: true,
          },
        },
      };
      let response;
      if (providerId === OFFICIAL_PROVIDER_ID) {
        const operationController = new AbortController();
        let didTimeOut = false;
        const deadline = scheduler.setTimeout(() => {
          didTimeOut = true;
          operationController.abort();
        }, OFFICIAL_TIMEOUT_MS);
        const abortFromCaller = () =>
          operationController.abort(request.signal?.reason);
        if (request.signal?.aborted) abortFromCaller();
        else
          request.signal?.addEventListener("abort", abortFromCaller, {
            once: true,
          });
        try {
          response = await officialClient.responses.create(body, {
            signal: operationController.signal,
            maxRetries: 0,
            timeout: OFFICIAL_TIMEOUT_MS,
          });
        } catch (error) {
          throw new SafeDiagnosticError({
            providerId,
            code: didTimeOut ? "provider_timeout" : "provider_request_failed",
            httpStatus: safeHttpStatus(error),
          });
        } finally {
          scheduler.clearTimeout(deadline);
          request.signal?.removeEventListener("abort", abortFromCaller);
        }
      } else {
        let boundedError;
        const boundedFetch = createBoundedAllowlistedFetch({
          fetch: dependencies.fetch,
          scheduler,
          signal: request.signal,
          onError(error) {
            boundedError ??= error;
          },
        });
        const credentialOptions = {
          ...(dependencies.authFile ? { authFile: dependencies.authFile } : {}),
          ...(dependencies.projectRoot
            ? { projectRoot: dependencies.projectRoot }
            : {}),
          ...(dependencies.environment
            ? { environment: dependencies.environment }
            : {}),
          ...(dependencies.now ? { now: dependencies.now } : {}),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          scheduler,
          signal: request.signal,
        };
        const transport = createOpenAIOAuthTransport({
          auth: () => loadFreshChatGptSession(credentialOptions),
          baseURL: OAUTH_BASE_URL,
          codexVersion: OAUTH_CODEX_VERSION,
          responsesState: false,
          fetch: boundedFetch,
        });
        const client = new OpenAI({
          apiKey,
          adminAPIKey: null,
          organization: null,
          project: null,
          webhookSecret: null,
          baseURL: transport.baseURL,
          fetch: transport.fetch,
          maxRetries: 0,
          timeout: OAUTH_SDK_TIMEOUT_MS,
          logLevel: "off",
          logger: silentSdkLogger,
        });
        try {
          response = await client.responses.create(body, {
            signal: request.signal,
            maxRetries: 0,
            timeout: OAUTH_SDK_TIMEOUT_MS,
          });
          if (boundedError) throw boundedError;
        } catch (error) {
          if (boundedError) throw boundedError;
          if (error instanceof SafeDiagnosticError) throw error;
          throw new SafeDiagnosticError({
            providerId,
            code: "provider_request_failed",
            httpStatus: safeHttpStatus(error),
          });
        }
      }

      let extracted;
      try {
        extracted = extractStructuredOutput(response, {
          desiredClipCount,
          maximumOutputTextUtf8Bytes,
          ...(task ? { outputSchema: task.outputSchema } : {}),
        });
      } catch (error) {
        throw new SafeDiagnosticError({
          providerId,
          code:
            error instanceof InvalidSelectionOutputError
              ? "selection_output_invalid"
              : "provider_response_invalid",
        });
      }
      const responseId = safeResponseId(extracted.responseId);
      return {
        parsed: extracted.parsed,
        provenance: {
          providerId,
          model: SELECTOR_MODEL,
          ...(responseId ? { responseId } : {}),
          recipeSha256,
          ...(extracted.usage ? { usage: extracted.usage } : {}),
        },
      };
    },
  };
};

export const createStructuredGenerationProvider = (config, dependencies = {}) =>
  createProvider(config, dependencies);
// Explicitly separated from the immutable transcript-selector contract.
export function createTaskGenerationProvider(config, task, dependencies = {}) {
  if (
    !/^[a-z][a-z0-9_]{1,60}$/.test(task?.name ?? "") ||
    typeof task?.instructions !== "string" ||
    !task.instructions ||
    !task.jsonSchema ||
    typeof task.outputSchema?.safeParse !== "function"
  )
    throw Error("Invalid generation task contract");
  const fixed = {
    ...task,
    jsonSchema: JSON.parse(canonicalJson(task.jsonSchema)),
  };
  return createProvider(config, dependencies, fixed);
}
