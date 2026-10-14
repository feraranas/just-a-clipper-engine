import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { recoveryFixture } from "./test-support/recovery-fixture.mjs";
import { openRecoveryStore } from "./publishing-recovery-store.mjs";
import { inspectRecovery } from "./publishing-recovery.mjs";

import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingServer } from "./publishing-server.mjs";

const fixture = {
  artifactRelativePath: "out/reels/fixture.mp4",
  artifactHash: "sha256:fixture",
  title: "Fixture Reel",
  caption: "Original caption",
  accountId: "instagram-test",
};

test("server resolves the default public directory", () => {
  const server = createPublishingServer({
    projectRoot: process.cwd(),
    ledger: {},
  });
  server.close();
});

test("caption edits revoke approval and safe retries return to review through the API", async (t) => {
  const { item, baseUrl, ledger } = await setup(t);
  ledger.approveItem(item.id, "2026-09-20T11:00:00Z");
  const changed = await call(baseUrl, "POST", `/api/items/${item.id}/caption`, {
    caption: "New caption",
  });
  assert.equal(changed.body.item.state, "queued");
  assert.equal(changed.body.item.approvedCaption, null);
  ledger.approveItem(item.id, "2026-09-20T11:00:00Z");
  ledger.transitionItem(item.id, "approved", "failed", { safeToRetry: true });
  const retry = await call(baseUrl, "POST", `/api/items/${item.id}/retry`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.item.state, "queued");
});

const setup = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "publishing-server-"));
  await mkdir(join(root, "out/reels"), { recursive: true });
  await mkdir(join(root, "publishing"), { recursive: true });
  await writeFile(
    join(root, "publishing/index.html"),
    "<main>approval queue</main>",
  );
  await writeFile(
    join(root, "publishing/app.mjs"),
    "export const ready = true;",
  );
  await writeFile(join(root, "publishing/styles.css"), "body { color: red; }");
  await writeFile(join(root, fixture.artifactRelativePath), "fixture mp4");
  const ledger = createPublishingLedger(join(root, "publishing.sqlite"));
  const item = ledger.enqueueArtifact(fixture);
  const server = createPublishingServer({
    projectRoot: root,
    ledger,
    publicRoot: join(root, "publishing"),
    pipelineLogPath: join(root, "pipeline.jsonl"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  t.after(() => {
    server.close();
    ledger.close();
  });
  return { item, ledger, root, baseUrl: `http://127.0.0.1:${address.port}` };
};

const call = (baseUrl, method, path, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = request(
      url,
      { method, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });

test("history endpoint is bounded, sanitized, durable across reapproval and newer attempts", async t => {
  const f=await recoveryFixture(t), store=openRecoveryStore(f.path);
  store.applyRecovery(await inspectRecovery({...f,store})); store.close();
  f.ledger.approveItem(f.itemId,"2026-10-03T00:00:00Z"); f.ledger.claimDueApprovedItem("2026-10-13T00:00:00Z"); f.execution.beginAttempt(f.itemId);
  const server=createPublishingServer({ledger:f.ledger});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const route=`/api/items/${f.itemId}/history`;
    const r=await call(base,"GET",route);
    assert.equal(r.status,200); assert.equal(r.headers["cache-control"],"no-store");
    assert.equal(r.body.attempts.length,2);
    const old=r.body.attempts.find(a=>a.attemptId===f.attemptId);
    assert.equal(old.outcome,"Video upload failed"); assert.ok(old.recoveredAt);
    assert.ok(!JSON.stringify(r.body).includes("rupload"));
    const db=new DatabaseSync(f.path);
    db.prepare("UPDATE publishing_attempts SET error_code='SECRET_TOKEN',upload_uri='secret',error_code='SECRET_TOKEN' WHERE id<>?").run(f.attemptId);
    for(let i=0;i<25;i++) db.prepare("INSERT INTO publishing_attempts(id,item_id,phase,created_at,updated_at) VALUES (?,?,'unknown','2026-10-13','2026-10-13')").run(`extra-${i}`,f.itemId);
    db.close();
    const bounded=await call(base,"GET",route); assert.equal(bounded.body.attempts.length,20); assert.ok(!JSON.stringify(bounded.body).includes("SECRET_TOKEN"));
    assert.equal((await call(base,"GET","/api/items/nonexistent/history")).status,404);
  } finally { await new Promise(r=>server.close(r)); }
});
test("legacy missing history tables return empty list without schema initialization", async t => {
  const {root,item,baseUrl}=await setup(t);
  const db=new DatabaseSync(join(root,"publishing.sqlite"));
  const before=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const r=await call(baseUrl,"GET",`/api/items/${item.id}/history`);
  assert.equal(r.status,200); assert.deepEqual(r.body,{attempts:[]});
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),before); db.close();
});

test("creates a server when publicRoot uses its default path", () => {
  assert.doesNotThrow(() => createPublishingServer({ ledger: {} }));
});

test("logs API tolerates damaged records and returns an uncached bounded window", async (t) => {
  const { root, baseUrl } = await setup(t);
  assert.deepEqual((await call(baseUrl, "GET", "/api/logs")).body, {
    events: [],
  });
  await writeFile(
    join(root, "pipeline.jsonl"),
    [
      JSON.stringify({ stage: "render", status: "started" }),
      "broken",
      JSON.stringify({
        stage: "render",
        status: "failed",
        errorCode: "render_failed",
        message: "private",
      }),
      '{"partial":',
    ].join("\n"),
  );
  const response = await call(baseUrl, "GET", "/api/logs?limit=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body.events, [
    { stage: "render", status: "failed", errorCode: "render_failed" },
  ]);
});

test("lists queue items and persists a caption update", async (t) => {
  const { item, baseUrl } = await setup(t);
  const page = await call(baseUrl, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  const module = await call(baseUrl, "GET", "/app.mjs");
  assert.equal(module.status, 200);
  assert.match(module.headers["content-type"], /javascript/);
  const styles = await call(baseUrl, "GET", "/styles.css");
  assert.equal(styles.status, 200);
  assert.match(styles.headers["content-type"], /text\/css/);

  const queue = await call(baseUrl, "GET", "/api/items");
  assert.equal(queue.status, 200);
  assert.equal(queue.body.items[0].id, item.id);

  const updated = await call(baseUrl, "POST", `/api/items/${item.id}/caption`, {
    caption: "Edited caption",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.item.caption, "Edited caption");
});

test("returns JSON errors for invalid approval and rejection requests", async (t) => {
  const { item, baseUrl } = await setup(t);
  const missingSchedule = await call(
    baseUrl,
    "POST",
    `/api/items/${item.id}/approve`,
    {},
  );
  assert.equal(missingSchedule.status, 400);
  assert.equal(typeof missingSchedule.body.error, "string");

  const missingReason = await call(
    baseUrl,
    "POST",
    `/api/items/${item.id}/reject`,
    {},
  );
  assert.equal(missingReason.status, 400);
  assert.equal(typeof missingReason.body.error, "string");
});

test("approves and rejects through state-aware routes", async (t) => {
  const first = await setup(t);
  const approved = await call(
    first.baseUrl,
    "POST",
    `/api/items/${first.item.id}/approve`,
    { scheduledAt: "2026-09-21T12:00:00.000Z" },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.item.state, "approved");
  const again = await call(
    first.baseUrl,
    "POST",
    `/api/items/${first.item.id}/approve`,
    { scheduledAt: "2026-09-21T12:00:00.000Z" },
  );
  assert.equal(again.status, 409);

  const second = await setup(t);
  const rejected = await call(
    second.baseUrl,
    "POST",
    `/api/items/${second.item.id}/reject`,
    { reason: "Needs review" },
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.item.state, "rejected");
});

test("rejects preview path traversal and serves a validated MP4", async (t) => {
  const { item, baseUrl, ledger } = await setup(t);
  const preview = await call(baseUrl, "GET", `/api/items/${item.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers["content-type"], /video\/mp4/);

  ledger.enqueueArtifact({
    ...fixture,
    id: "traversal",
    artifactRelativePath: "../secret.mp4",
    artifactHash: "sha256:bad",
  });
  const blocked = await call(baseUrl, "GET", "/api/items/traversal/preview");
  assert.equal(blocked.status, 404);
});

test("does not retry failed or unknown items without safe confirmation", async (t) => {
  const { item, baseUrl, ledger } = await setup(t);
  ledger.approveItem(item.id, "2026-09-21T12:00:00.000Z");
  ledger.transitionItem(item.id, "approved", "uploading");
  ledger.recordUnknownOutcome(item.id, { errorCode: "TIMEOUT" });
  const retry = await call(baseUrl, "POST", `/api/items/${item.id}/retry`, {});
  assert.equal(retry.status, 409);
  const verify = await call(
    baseUrl,
    "POST",
    `/api/items/${item.id}/verify-published`,
    { mediaId: "media-1" },
  );
  assert.equal(verify.status, 409);
});
