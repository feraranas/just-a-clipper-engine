import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadSampleRegistry, readPoster } from "./template-sample-registry.mjs";
import { samplePage } from "./template-sample-page.mjs";
export async function startSampleServer({
  sampleRoot,
  projectRoot = process.cwd(),
  environment = process.env,
  port,
} = {}) {
  const selected = port ?? Number(environment.AUDIOGRAM_SAMPLE_PORT ?? 8790);
  if (
    !Number.isInteger(selected) ||
    selected < 0 ||
    selected > 65535 ||
    (port === undefined && selected === 0)
  )
    throw new Error(
      "AUDIOGRAM_SAMPLE_PORT must be an integer from 1 to 65535.",
    );
  const entries = await loadSampleRegistry({
    sampleRoot,
    projectRoot,
    environment,
  });
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const reply = (code, body, type = "text/plain; charset=utf-8") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Allow", "GET, HEAD");
      return reply(405, "Method not allowed.");
    }
    const route = req.url?.split("?")[0];
    if (route === "/health")
      return reply(200, JSON.stringify({ status: "ok" }), "application/json");
    const entry = entries.find(
      (e) =>
        route === e.basePath ||
        route === e.basePath + "poster.jpg" ||
        route === e.basePath + "poster/" + e.posterHash + ".jpg",
    );
    if (!entry) return reply(404, "Sample not found.");
    try {
      const bytes = await readPoster(entry);
      if (route === entry.basePath) {
        const { html, csp } = samplePage(entry);
        res.setHeader("Content-Security-Policy", csp);
        return reply(200, html, "text/html; charset=utf-8");
      }
      const etag = '"' + entry.posterHash + '"';
      res.setHeader("ETag", etag);
      res.setHeader(
        "Cache-Control",
        route.endsWith("/poster.jpg")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      return reply(200, bytes, "image/jpeg");
    } catch {
      return reply(503, "Sample asset is unavailable. Please try again later.");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(selected, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const server = await startSampleServer();
    console.log(
      `Sample server listening at ${server.url}/samples/classic/1/default/`,
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await server.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(
      `Sample server could not start: ${error.code === "EADDRINUSE" ? "Port is already in use." : error.message}`,
    );
    process.exitCode = 1;
  }
}
