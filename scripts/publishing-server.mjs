import { artifactLocation } from "./artifact-store.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import { readPipelineEvents } from "./pipeline-logger.mjs";
import { resolvePipelineLogPath } from "./publishing-config.mjs";
import { createJobDebugReader } from "./job-debug-store.mjs";
import { handleJobDebug } from "./job-debug-http.mjs";

const json = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const readJson = async (request) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
};

const contentType = (path) => {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
};

const errorStatus = (error) =>
  /not found/i.test(error.message)
    ? 404
    : /state|transition|unknown|retry|approve|caption/i.test(error.message)
      ? 409
      : 400;

export const createPublishingServer = ({
  projectRoot = process.cwd(),
  ledger,
  publicRoot = join(projectRoot, "public/publishing"),
  pipelineLogPath = resolvePipelineLogPath(process.env),
  artifactRoot = resolveStorageConfig().artifactRoot,
  debugReader,
  debugPublicRoot = join(projectRoot, "public/job-debug"),
}) => {
  if (!ledger) throw new Error("ledger is required");
  const diagnostics = debugReader ?? createJobDebugReader({
    jobsDbPath:
      process.env.AUDIOGRAM_DEBUG_JOBS_DB_PATH ??
      process.env.AUDIOGRAM_JOB_STORE ??
      join(projectRoot, ".local/audiogram-helper-jobs.sqlite"),
    diagnosticsRoot:
      process.env.AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT ??
      process.env.AUDIOGRAM_DIAGNOSTICS_ROOT ??
      join(projectRoot, ".local/audiogram-helper/runs"),
    sourceLabel: process.env.AUDIOGRAM_DEBUG_SOURCE_LABEL ?? "Local jobs",
  });
  return createServer(async (request, response) => {
    try {
      if (await handleJobDebug(request, response, {
        reader: diagnostics,
        publicRoot: debugPublicRoot,
      })) return;
      const url = new URL(request.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/api/items")
        return json(response, 200, { items: ledger.getQueue() });
      if (request.method === "GET" && url.pathname === "/api/logs") {
        response.setHeader("Cache-Control", "no-store");
        const rawLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(rawLimit)
          ? Math.min(Math.max(rawLimit, 1), 1000)
          : 100;
        return json(response, 200, {
          events: await readPipelineEvents(pipelineLogPath, { limit }),
        });
      }
      if (parts[0] === "api" && parts[1] === "items" && parts[2]) {
        const id = parts[2];
        if (request.method === "GET" && parts.length === 4 && parts[3] === "history") {
          response.setHeader("Cache-Control", "no-store");
          if (!ledger.getPublishingItem(id)) return json(response,404,{error:"Item not found"});
          return json(response,200,{attempts:ledger.getAttemptHistory(id)});
        }
        if (request.method === "GET" && parts.length === 3) {
          const item = ledger.getPublishingItem(id);
          return item
            ? json(response, 200, { item })
            : json(response, 404, { error: "Item not found" });
        }
        if (request.method === "GET" && parts[3] === "preview") {
          const item = ledger.getPublishingItem(id);
          if (!item) return json(response, 404, { error: "Item not found" });
          const { path } = await artifactLocation(
            projectRoot,
            item.artifactRelativePath,
            { artifactRoot },
          );
          const info = await stat(path);
          response.writeHead(200, {
            "content-type": "video/mp4",
            "content-length": info.size,
          });
          return createReadStream(path).pipe(response);
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          let item;
          if (parts[3] === "caption")
            item = ledger.updateCaption(id, body.caption);
          else if (parts[3] === "approve" || parts[3] === "schedule")
            item = ledger.approveItem(id, body.scheduledAt);
          else if (parts[3] === "reject")
            item = ledger.rejectItem(id, body.reason);
          else if (parts[3] === "retry") {
            item = ledger.retryFailedItem(id);
          } else if (parts[3] === "verify-published") {
            throw new Error(
              "Unknown outcomes require explicit external verification",
            );
          } else return json(response, 404, { error: "Route not found" });
          return json(response, 200, { item });
        }
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const path = resolve(publicRoot, file);
        if (!path.startsWith(resolve(publicRoot) + sep))
          return json(response, 404, { error: "Not found" });
        const body = await readFile(path);
        response.writeHead(200, { "content-type": contentType(path) });
        return response.end(body);
      }
      return json(response, 404, { error: "Route not found" });
    } catch (error) {
      return json(
        response,
        error.code === "ARTIFACT_UNAVAILABLE" ? 404 : errorStatus(error),
        {
          error: error.message,
          ...(error.code === "ARTIFACT_UNAVAILABLE"
            ? { code: error.code }
            : {}),
        },
      );
    }
  });
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  const { createPublishingLedger } = await import("./publishing-ledger.mjs");
  const ledger = createPublishingLedger(resolveStorageConfig().publishingDb);
  const server = createPublishingServer({ ledger, projectRoot: process.cwd() });
  server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () =>
    console.log("Publishing server listening"),
  );
}
