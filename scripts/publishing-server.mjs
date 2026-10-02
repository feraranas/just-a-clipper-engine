import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import { readPipelineEvents } from "./pipeline-logger.mjs";
import { resolvePipelineLogPath, resolvePublishingLedgerPath } from "./publishing-config.mjs";

const json = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
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

const safeArtifact = (projectRoot, artifactRelativePath) => {
  if (typeof artifactRelativePath !== "string" || artifactRelativePath.trim() === "") throw new Error("artifact path is required");
  const root = resolve(projectRoot);
  const target = resolve(root, artifactRelativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(root, rel) !== target) throw new Error("artifact path must stay inside the project repository");
  if (extname(target).toLowerCase() !== ".mp4") throw new Error("preview is only available for MP4 artifacts");
  return target;
};

const errorStatus = (error) => /not found/i.test(error.message) ? 404 : /state|transition|unknown|retry|approve|caption/i.test(error.message) ? 409 : 400;

export const createPublishingServer = ({ projectRoot = process.cwd(), ledger, publicRoot = join(projectRoot, "public/publishing"), pipelineLogPath = resolvePipelineLogPath(process.env) }) => {
  if (!ledger) throw new Error("ledger is required");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/api/items") return json(response, 200, { items: ledger.getQueue() });
      if (request.method === "GET" && url.pathname === "/api/logs") {
        const rawLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;
        return json(response, 200, { events: await readPipelineEvents(pipelineLogPath, { limit }) });
      }
      if (parts[0] === "api" && parts[1] === "items" && parts[2]) {
        const id = parts[2];
        if (request.method === "GET" && parts.length === 3) {
          const item = ledger.getPublishingItem(id);
          return item ? json(response, 200, { item }) : json(response, 404, { error: "Item not found" });
        }
        if (request.method === "GET" && parts[3] === "preview") {
          const item = ledger.getPublishingItem(id);
          if (!item) return json(response, 404, { error: "Item not found" });
          const path = safeArtifact(projectRoot, item.artifactRelativePath);
          const info = await stat(path);
          response.writeHead(200, { "content-type": "video/mp4", "content-length": info.size });
          return createReadStream(path).pipe(response);
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          let item;
          if (parts[3] === "caption") item = ledger.updateCaption(id, body.caption);
          else if (parts[3] === "approve" || parts[3] === "schedule") item = ledger.approveItem(id, body.scheduledAt);
          else if (parts[3] === "reject") item = ledger.rejectItem(id, body.reason);
          else if (parts[3] === "retry") {
            const current = ledger.getPublishingItem(id);
            if (!current || current.state !== "failed") throw new Error(`Cannot retry item in state: ${current?.state ?? "missing"}`);
            item = ledger.transitionItem(id, "failed", "approved");
          } else if (parts[3] === "verify-published") {
            throw new Error("Unknown outcomes require explicit external verification");
          } else return json(response, 404, { error: "Route not found" });
          return json(response, 200, { item });
        }
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const path = resolve(publicRoot, file);
        if (!path.startsWith(resolve(publicRoot) + sep)) return json(response, 404, { error: "Not found" });
        const body = await readFile(path);
        response.writeHead(200, { "content-type": contentType(path) });
        return response.end(body);
      }
      return json(response, 404, { error: "Route not found" });
    } catch (error) {
      return json(response, errorStatus(error), { error: error.message });
    }
  });
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const { createPublishingLedger } = await import("./publishing-ledger.mjs");
  const ledger = createPublishingLedger(
    process.env.PUBLISHING_DB ?? resolvePublishingLedgerPath(process.env),
  );
  const server = createPublishingServer({ ledger, projectRoot: process.cwd() });
  server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () => console.log("Publishing server listening"));
}
