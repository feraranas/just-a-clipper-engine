import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import path from "node:path";
import { createJobStore } from "./job-store.mjs";
import { createLocalRunner, parseAndValidateUrl } from "./local-runner.mjs";
import { validateMcpRuntimeConfig } from "./runtime-config.mjs";

const HOST = "127.0.0.1";
const JOB_STORE_PATH = (root) =>
  process.env.AUDIOGRAM_JOB_STORE ??
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
        stage: z.enum([
          "worker",
          "intake",
          "metadata",
          "setup",
          "transcript",
          "selection",
          "jev",
          "assets",
          "render",
          "artifact_verification",
        ]),
        code: z.string(),
        message: z.string(),
        packageId: z.string().optional(),
      }),
    )
    .optional(),
  retryOfJobId: z.string().uuid().optional(),
  diagnosticsIncomplete: z.boolean().optional(),
};

function makeMcpServer({ runner }) {
  const server = new McpServer({ name: "audiogram-helper", version: "0.1.0" });
  server.registerTool(
    "create_audiogram",
    {
      description:
        "Create local captioned clip drafts from one public YouTube video URL. Processing may take time; use get_audiogram_status to check it.",
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
        });
        return {
          content: [
            {
              type: "text",
              text: `Audiogram job ${state.jobId} is ${state.status}.`,
            },
          ],
          structuredContent: { title: null, artifacts: [], ...state },
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
        "Check a previously started Audiogram job and retrieve verified local artifact paths after completion.",
      inputSchema: { jobId: z.string().uuid() },
      outputSchema: outputShape,
    },
    async ({ jobId }) => {
      const state = await runner.getStatus(jobId);
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
        "Retry a failed or partial Audiogram as a new job. Ask the user for explicit approval before calling this tool.",
      inputSchema: { jobId: z.string().uuid() },
      outputSchema: outputShape,
    },
    async ({ jobId }) => {
      try {
        const state = await runner.retry({ jobId });
        if (!state)
          return {
            isError: true,
            content: [{ type: "text", text: "Audiogram job was not found." }],
          };
        return {
          content: [
            {
              type: "text",
              text: `Audiogram retry ${state.jobId} is ${state.status}.`,
            },
          ],
          structuredContent: { title: null, artifacts: [], ...state },
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
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required.");
  let store;
  if (!runner) {
    store = createJobStore(JOB_STORE_PATH(projectRoot));
    runner = createLocalRunner({
      jobStore: store,
      projectRoot,
      workerPath: path.join(
        projectRoot,
        "plugins/audiogram-helper/job-worker.mjs",
      ),
    });
  }
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
    const mcp = makeMcpServer({ runner });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    } finally {
      await Promise.allSettled([mcp.close(), transport.close()]);
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  return {
    address,
    url: `http://${HOST}:${address.port}/mcp`,
    close: async () => {
      await new Promise((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      store?.close();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  try {
    validateMcpRuntimeConfig(process.env);
  } catch (error) {
    process.stderr.write(`Audiogram MCP configuration error: ${error.message}\n`);
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
