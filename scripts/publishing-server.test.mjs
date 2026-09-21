import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";

import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingServer } from "./publishing-server.mjs";

const fixture = {
  artifactRelativePath: "out/reels/fixture.mp4",
  artifactHash: "sha256:fixture",
  title: "Fixture Reel",
  caption: "Original caption",
  accountId: "instagram-test",
};

const setup = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "publishing-server-"));
  await mkdir(join(root, "out/reels"), { recursive: true });
  await writeFile(join(root, fixture.artifactRelativePath), "fixture mp4");
  const ledger = createPublishingLedger(join(root, "publishing.sqlite"));
  const item = ledger.enqueueArtifact(fixture);
  const server = createPublishingServer({ projectRoot: root, ledger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  t.after(() => {
    server.close();
    ledger.close();
  });
  return { item, ledger, baseUrl: `http://127.0.0.1:${address.port}` };
};

const call = (baseUrl, method, path, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = request(url, { method, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });

test("lists queue items and persists a caption update", async (t) => {
  const { item, baseUrl } = await setup(t);
  const queue = await call(baseUrl, "GET", "/api/items");
  assert.equal(queue.status, 200);
  assert.equal(queue.body.items[0].id, item.id);

  const updated = await call(baseUrl, "POST", `/api/items/${item.id}/caption`, { caption: "Edited caption" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.item.caption, "Edited caption");
});

test("approves and rejects through state-aware routes", async (t) => {
  const first = await setup(t);
  const approved = await call(first.baseUrl, "POST", `/api/items/${first.item.id}/approve`, { scheduledAt: "2026-09-21T12:00:00.000Z" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.item.state, "approved");
  const again = await call(first.baseUrl, "POST", `/api/items/${first.item.id}/approve`, { scheduledAt: "2026-09-21T12:00:00.000Z" });
  assert.equal(again.status, 409);

  const second = await setup(t);
  const rejected = await call(second.baseUrl, "POST", `/api/items/${second.item.id}/reject`, { reason: "Needs review" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.item.state, "rejected");
});

test("rejects preview path traversal and serves a validated MP4", async (t) => {
  const { item, baseUrl, ledger } = await setup(t);
  const preview = await call(baseUrl, "GET", `/api/items/${item.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers["content-type"], /video\/mp4/);

  ledger.enqueueArtifact({ ...fixture, id: "traversal", artifactRelativePath: "../secret.mp4", artifactHash: "sha256:bad" });
  const blocked = await call(baseUrl, "GET", "/api/items/traversal/preview");
  assert.equal(blocked.status, 400);
});

test("does not retry failed or unknown items without safe confirmation", async (t) => {
  const { item, baseUrl, ledger } = await setup(t);
  ledger.approveItem(item.id, "2026-09-21T12:00:00.000Z");
  ledger.transitionItem(item.id, "approved", "uploading");
  ledger.recordUnknownOutcome(item.id, { errorCode: "TIMEOUT" });
  const retry = await call(baseUrl, "POST", `/api/items/${item.id}/retry`, {});
  assert.equal(retry.status, 409);
  const verify = await call(baseUrl, "POST", `/api/items/${item.id}/verify-published`, { mediaId: "media-1" });
  assert.equal(verify.status, 409);
});
