import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { handleJobDebug } from "./job-debug-http.mjs";
const id = "92fd058e-e006-4f69-bce7-c267983fdec8";
test("local routes are read-only, uncached, origin checked, and hide internal errors", async (t) => {
  const reader = {
    listJobs: () => ({ jobs: [] }),
    getJob: (jobId) => ({ job: { jobId } }),
    events: () => ({ events: [] }),
    deliveries: () => {
      throw new Error("PRIVATE filesystem or secret");
    },
  };
  const server = createServer(async (req, res) => {
    if (
      !(await handleJobDebug(req, res, { reader, publicRoot: "/nonexistent" }))
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const r = request(base + path, { headers, method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      });
      r.on("error", reject);
      r.end();
    });
  const list = await call("/api/debug/jobs");
  assert.equal(list.status, 200);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.equal((await call(`/api/debug/jobs/${id}`)).status, 200);
  assert.equal((await call(`/api/debug/jobs/${id}/events`)).status, 200);
  assert.equal(
    (await call("/api/debug/jobs", { origin: "https://evil.test" })).status,
    403,
  );
  assert.equal(
    (await call("/api/debug/jobs", { host: "evil.test" })).status,
    403,
  );
  assert.equal(
    (await call("/api/debug/jobs", { "sec-fetch-site": "cross-site" })).status,
    403,
  );
  assert.equal((await call("/api/debug/jobs", {}, "POST")).status, 405);
  assert.equal((await call("/api/debug/jobs/not-an-id")).status, 400);
  assert.equal((await call(`/api/debug/jobs/${id}/extra`)).status, 404);
  const failure = await call(`/api/debug/jobs/${id}/deliveries`);
  assert.equal(failure.status, 503);
  assert.ok(!failure.body.includes("PRIVATE"));
  assert.equal((await call("/debug/jobs")).status, 503);
});
