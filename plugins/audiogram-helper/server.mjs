import {
  buildTemplateListing,
  templateListingShape,
} from "./template-listing.mjs";
import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { createEventMethods } from "./mcp-events.mjs";
import { createWebhookClient } from "./mcp-webhook.mjs";
import { startEventDispatcher } from "./mcp-event-dispatcher.mjs";
import { recoverPendingFinalizations } from "./mcp-finalization.mjs";
import { resolveDiagnosticsRoot } from "./job-diagnostics.mjs";
import { validateStoredResult } from "./result-validation.mjs";
import { resolveStorageConfig } from "../../scripts/storage-config.mjs";
import { createMcpHttpHandler } from "./mcp-http.mjs";
import { z } from "zod";
import path from "node:path";
import { createJobStore } from "./job-store.mjs";
import { JOB_STAGES } from "./job-stages.mjs";
import { EVENT_NAMES } from "./mcp-event-contract.mjs";
import { createLocalRunner, parseAndValidateUrl } from "./local-runner.mjs";
import { validateMcpRuntimeConfig } from "./runtime-config.mjs";
import {
  buildTemplateUi,
  registerTemplateUi,
  TEMPLATE_UI_URI,
} from "./template-ui-resource.mjs";

const HOST = "127.0.0.1";
const JOB_STORE_PATH = (root, environment = process.env) =>
  environment.AUDIOGRAM_JOB_STORE ??
  path.join(root, ".local", "audiogram-helper-jobs.sqlite");
const outputShape = {
  jobId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "complete",
    "no_clips",
    "failed",
    "partial",
  ]),
  title: z.string().nullable().optional(),
  artifacts: z.array(z.string()),
  error: z.string().nullable().optional(),
  failures: z
    .array(
      z.object({
        stage: z.enum(JOB_STAGES),
        code: z.string(),
        message: z.string(),
        packageId: z.string().optional(),
      }),
    )
    .optional(),
  retryOfJobId: z.string().uuid().optional(),
  diagnosticsIncomplete: z.boolean().optional(),
  monitoring: z
    .strictObject({
      available: z.boolean(),
      jobId: z.string(),
      eventNames: z.array(z.enum(EVENT_NAMES)),
      instruction: z.string(),
    })
    .optional(),
  notificationHealth: z
    .strictObject({
      capture: z.enum(["complete", "incomplete", "unknown"]),
      delivery: z
        .enum(["not_subscribed", "active", "degraded", "stopped"])
        .optional(),
      subscriptions: z
        .array(
          z.strictObject({
            id: z.string(),
            name: z.enum(["audiogram.job.progress", "audiogram.job.finished"]),
            state: z.string(),
          }),
        )
        .max(50)
        .optional(),
    })
    .optional(),
};

function makeMcpServer({
  runner,
  templateCatalog,
  templateUi,
  principal,
  eventsEnabled,
}) {
  const server = new McpServer({ name: "audiogram-helper", version: "0.1.0" });
  const monitoring = (jobId) => ({
    available: Boolean(eventsEnabled),
    jobId,
    eventNames: eventsEnabled ? [...EVENT_NAMES] : [],
    instruction: eventsEnabled
      ? "After receiving this job ID, subscribe automatically to both event names using events/subscribe and arguments.job_id. Do not wait for a separate request for live updates. Respect an explicit request not to monitor and host approval requirements. Use the discovered event catalog, or call events/list if its definitions are unknown. Confirm full monitoring only when both subscriptions are active. A job ID does not prove subscription activation."
      : "Automatic updates are unavailable on this server. Use get_audiogram_status when the user requests a status check. Do not create another job to restore monitoring.",
  });
  registerTemplateUi(server, templateUi);
  server.registerTool(
    "list_video_templates",
    {
      description:
        "List available video templates, their variations, public sample preview links, and valid selections for create_audiogram. Show the preview page link when available so the user can watch the sample before choosing. Video and poster URLs point directly to the public media host. This tool does not start a job.",
      inputSchema: z.strictObject({}),
      outputSchema: templateListingShape,
      _meta: {
        ui: { resourceUri: TEMPLATE_UI_URI },
        "openai/outputTemplate": TEMPLATE_UI_URI,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const listing = buildTemplateListing(templateCatalog);
        return {
          structuredContent: listing,
          content: [
            {
              type: "text",
              text:
                listing.templates
                  .map(
                    (t) =>
                      `${t.name}: ${t.description} Input: ${t.supportedInput}. Variations: ${t.variations.map((v) => `${v.variationId} (${v.description})`).join(", ")}. Default selection: ${JSON.stringify(t.defaultSelection)}.${t.variations
                        .filter((v) => v.preview)
                        .map(
                          (v) =>
                            `\n[Preview ${t.name} (${v.variationId})](${v.preview.pageUrl})`,
                        )
                        .join("")}`,
                  )
                  .join("\n") || "No video templates are available.",
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "The video template catalog is invalid or unavailable. Contact the server operator before choosing a template.",
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "create_audiogram",
    {
      description:
        "Create captioned clip drafts from one public YouTube URL. Return the job ID. Follow monitoring guidance automatically unless the user declines updates. Job creation does not activate subscriptions.",
      inputSchema: {
        url: z.string().min(1).max(2048),
        templateId: z.string().optional(),
        templateVersion: z.string().optional(),
        variationId: z.string().optional(),
      },
      outputSchema: outputShape,
    },
    async ({ url, ...templateSelection }) => {
      let parsed;
      let resolved;
      try {
        resolved = resolveTemplateSelection(templateSelection);
        parsed = parseAndValidateUrl(url);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
      try {
        const state = await runner.start({
          url: parsed.sourceUrl,
          videoId: parsed.videoId,
          templateSelection: resolved.selection,
          ...(principal ? { principal } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text: `Audiogram job ${state.jobId} is ${state.status}. ${monitoring(state.jobId).instruction}`,
            },
          ],
          structuredContent: {
            title: null,
            artifacts: [],
            ...state,
            monitoring: monitoring(state.jobId),
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error.code === "VIDEO_BUSY_DIFFERENT_TEMPLATE"
                  ? error.message
                  : "Audiograms could not start this job.",
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "get_audiogram_status",
    {
      description:
        "Check a job's recorded status, verified artifacts, and notification health. Notification health is separate from processing status. This tool does not subscribe to updates.",
      inputSchema: { jobId: z.string().uuid() },
      outputSchema: outputShape,
    },
    async ({ jobId }) => {
      let state;
      try {
        state = await runner.getStatus(
          jobId,
          ...(principal ? [{ principal }] : []),
        );
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error.code === "ARTIFACT_UNAVAILABLE"
                  ? "ARTIFACT_UNAVAILABLE: A completed video is missing or changed. The historical job result has not changed."
                  : error.code === "FINALIZATION_PENDING"
                    ? "FINALIZATION_PENDING: The result is waiting for safe recording. Do not start another job."
                    : "Audiogram status is temporarily unavailable.",
            },
          ],
        };
      }
      if (!state)
        return {
          isError: true,
          content: [{ type: "text", text: "Audiogram job was not found." }],
        };
      return {
        content: [
          {
            type: "text",
            text: `Audiogram job ${state.jobId} is ${state.status}.`,
          },
        ],
        structuredContent: { title: null, artifacts: [], ...state },
      };
    },
  );
  server.registerTool(
    "retry_audiogram",
    {
      description:
        "Retry a failed or partial job as a new attempt. Ask the user for explicit approval before calling this tool. Return the new job ID and parent ID. Follow monitoring guidance automatically for the new ID unless the user declines updates.",
      inputSchema: { jobId: z.string().uuid() },
      outputSchema: outputShape,
    },
    async ({ jobId }) => {
      try {
        const state = await runner.retry({
          jobId,
          ...(principal ? { principal } : {}),
        });
        if (!state)
          return {
            isError: true,
            content: [{ type: "text", text: "Audiogram job was not found." }],
          };
        return {
          content: [
            {
              type: "text",
              text: `Audiogram retry ${state.jobId} is ${state.status}. ${monitoring(state.jobId).instruction}`,
            },
          ],
          structuredContent: {
            title: null,
            artifacts: [],
            ...state,
            monitoring: monitoring(state.jobId),
          },
        };
      } catch {
        return {
          isError: true,
          content: [
            { type: "text", text: "This Audiogram job cannot be retried." },
          ],
        };
      }
    },
  );
  return server;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw Object.assign(new Error("Request body too large."), {
        statusCode: 413,
      });
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Malformed JSON body."), { statusCode: 400 });
  }
}

export async function startMcpServer({
  projectRoot,
  runner,
  port = 7331,
  templateCatalog,
  principalResolver,
  environment = process.env,
  webhookClient,
  spawnProcess,
  isProcessAlive,
  clock = Date.now,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required.");
  const config = validateMcpRuntimeConfig(environment, {
    principalResolver,
    validateProcessing: !runner,
  });
  const templateUi = await buildTemplateUi();
  const controller = new AbortController();
  let store;
  const storePath = JOB_STORE_PATH(projectRoot, environment);
  const validateResult = (result) =>
    validateStoredResult(result, projectRoot, {
      artifactRoot: resolveStorageConfig(environment).artifactRoot,
    });
  if (!runner || config.eventsEnabled) {
    store = createJobStore(storePath, {
      eventsEnabled: config.eventsEnabled,
      eventOwnerMode: config.eventsMode,
      ownerId:
        config.eventsMode === "private-tunnel" ? "local-owner" : undefined,
      now: () => new Date(clock()).toISOString(),
    });
    try {
      if (
        config.eventsEnabled &&
        config.eventsMode === "shared" &&
        store.hasUnownedJobs()
      )
        throw new Error(
          "Shared Events requires an explicit owner migration for existing jobs.",
        );
      if (config.eventsEnabled)
        await recoverPendingFinalizations({
          store,
          recoveryRoot: resolveDiagnosticsRoot({
            projectRoot,
            diagnosticsRoot: environment.AUDIOGRAM_DIAGNOSTICS_ROOT,
          }),
          validateResult,
        });
    } catch (error) {
      store.close();
      throw error;
    }
    runner ??= createLocalRunner({
      jobStore: store,
      projectRoot,
      environment,
      eventsEnabled: config.eventsEnabled,
      jobStorePath: storePath,
      diagnosticsRoot: environment.AUDIOGRAM_DIAGNOSTICS_ROOT,
      ...(spawnProcess ? { spawnProcess } : {}),
      ...(isProcessAlive ? { isProcessAlive } : {}),
      workerPath: path.join(
        projectRoot,
        "plugins/audiogram-helper/job-worker.mjs",
      ),
    });
  }
  const resolver =
    config.eventsEnabled && config.eventsMode === "private-tunnel"
      ? async (request) => {
          const principal = principalResolver
            ? await principalResolver(request)
            : { id: "local-owner" };
          return principal?.id === "local-owner" ? principal : null;
        }
      : principalResolver;
  const webhook = config.eventsEnabled
    ? (webhookClient ?? createWebhookClient())
    : undefined;
  const methods = config.eventsEnabled
    ? createEventMethods({
        store,
        webhook,
        secrets: config.eventSecrets,
        clock,
        validateResult,
        signal: controller.signal,
      })
    : undefined;
  const handler = createMcpHttpHandler({
    makeServer: ({ principal, era }) =>
      makeMcpServer({
        runner,
        templateCatalog,
        templateUi,
        principal,
        eventsEnabled: config.eventsEnabled && era === "modern",
      }),
    principalResolver: resolver,
    eventHandler: methods
      ? (server, { principal }) => {
          server.server.registerCapabilities({ events: {} });
          for (const method of [
            "events/list",
            "events/subscribe",
            "events/unsubscribe",
          ])
            server.server.setRequestHandler(
              method,
              { params: z.looseObject({}), result: z.looseObject({}) },
              async (params) => {
                try {
                  return await methods.handleEventRequest({
                    principal,
                    method,
                    params,
                  });
                } catch (error) {
                  throw new ProtocolError(
                    error.code ?? -32603,
                    error.message,
                    error.data,
                  );
                }
              },
            );
        }
      : undefined,
  });
  const httpServer = createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    if (
      !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) ||
      (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin))
    ) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end('{"error":"Forbidden"}');
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      if (req.method === "POST") body = await readJsonBody(req);
    } catch (error) {
      res
        .writeHead(error.statusCode ?? 400, {
          "content-type": "application/json",
        })
        .end(JSON.stringify({ error: error.message }));
      return;
    }
    try {
      await handler.handleNodeRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, HOST, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    store?.close();
    throw error;
  }
  const dispatcher = methods
    ? startEventDispatcher({
        store,
        webhook,
        secrets: config.eventSecrets,
        clock,
        validateResult,
        onHealth: (health) =>
          process.stderr.write(`${JSON.stringify(health)}\n`),
      })
    : undefined;
  const address = httpServer.address();
  let closing;
  return {
    address,
    url: `http://${HOST}:${address.port}/mcp`,
    close: () =>
      (closing ??= (async () => {
        controller.abort();
        await dispatcher?.stop();
        await handler.close();
        await new Promise((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        );
        store?.close();
      })()),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  try {
    validateMcpRuntimeConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `Audiogram MCP configuration error: ${error.message}\n`,
    );
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) {
    const projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd();
    const server = await startMcpServer({
      projectRoot,
      port: Number(process.env.AUDIOGRAM_MCP_PORT ?? 7331),
    });
    process.stdout.write(`Audiogram MCP listening on ${server.url}\n`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
