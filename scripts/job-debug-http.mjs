import { readFile } from "node:fs/promises";
import { join } from "node:path";

const errors = new Set([
  "Invalid diagnostic request",
  "Invalid cursor",
  "Job not found",
  "Job database unavailable",
  "Unsafe diagnostic file",
  "Diagnostic log unavailable",
  "Diagnostic record exceeds read limit",
]);
function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
export async function handleJobDebug(req, res, { reader, publicRoot }) {
  const url = new URL(req.url, "http://localhost");
  if (
    !url.pathname.startsWith("/api/debug/") &&
    !url.pathname.startsWith("/debug/")
  )
    return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const port = req.socket.localPort;
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
  if (
    !local ||
    !hosts.has(req.headers.host) ||
    (req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`) ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    send(res, 403, { error: "Local same-origin access required" });
    return true;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    send(res, 405, { error: "Read-only endpoint" });
    return true;
  }
  try {
    const assets = {
      "/debug/jobs": ["index.html", "text/html"],
      "/debug/app.js": ["app.js", "text/javascript"],
      "/debug/app.css": ["app.css", "text/css"],
    };
    if (assets[url.pathname]) {
      const [name, type] = assets[url.pathname];
      let body;
      try {
        body = await readFile(join(publicRoot, name));
      } catch {
        send(res, 503, {
          error: "Console assets unavailable. Run npm run debug:build.",
        });
        return true;
      }
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      res.end(body);
      return true;
    }
    const args = {
      cursor: url.searchParams.get("cursor") || undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    };
    if (url.pathname === "/api/debug/jobs") {
      send(res, 200, reader.listJobs(args));
      return true;
    }
    const match =
      /^\/api\/debug\/jobs\/([^/]+)(?:\/(events|deliveries))?$/.exec(
        url.pathname,
      );
    if (!match) {
      send(res, 404, { error: "Diagnostic route not found" });
      return true;
    }
    const [, id, kind] = match;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      send(res, 400, { error: "Invalid Job ID" });
      return true;
    }
    const body =
      kind === "events"
        ? await reader.events(id, args)
        : kind === "deliveries"
          ? reader.deliveries(id, args)
          : reader.getJob(id);
    send(res, 200, body);
  } catch (error) {
    send(res, errors.has(error.message) ? error.status : 503, {
      error: errors.has(error.message)
        ? error.message
        : "Diagnostics unavailable",
    });
  }
  return true;
}
