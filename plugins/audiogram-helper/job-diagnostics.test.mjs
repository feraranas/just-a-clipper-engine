import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, utimes, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobDiagnostics } from "./job-diagnostics.mjs";

const ids = [
  "7bb07aec-e580-4ca4-a2fe-d96bc02b8035",
  "a08c7957-a47f-4e42-8cf7-bbc173183ae9",
];

test("job diagnostics isolate events and create private files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "job-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contexts = ids.map((jobId) =>
    createJobDiagnostics({ projectRoot: root, jobId }),
  );
  await Promise.all(
    contexts.map(({ logger }, index) =>
      logger.event({
        jobId: "attacker-value",
        runId: "attacker-value",
        stage: "render",
        status: "completed",
        message: "private message",
        transcript: "private transcript",
        apiKey: "private credential",
        count: index + 1,
      }),
    ),
  );

  for (const [index, context] of contexts.entries()) {
    const events = await context.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].jobId, ids[index]);
    assert.equal(events[0].runId, ids[index]);
    assert.equal(events[0].count, index + 1);
    assert.equal("message" in events[0], false);
    assert.equal("transcript" in events[0], false);
    assert.equal("apiKey" in events[0], false);
    assert.equal((await stat(context.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(context.files.events)).mode & 0o777, 0o600);
  }
});

test("job diagnostics rejects invalid UUIDs before creating paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "job-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => createJobDiagnostics({ projectRoot: root, jobId: "../../outside" }),
    /UUID/,
  );
});

test("job diagnostics removes expired run directories using the configured retention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "job-diagnostics-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expiredId = "d8bdcc2b-507f-4fd3-b702-ded1c7fd8a5b";
  const expiredPath = join(root, expiredId);
  await mkdir(expiredPath);
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(expiredPath, oldTime, oldTime);
  const current = createJobDiagnostics({
    projectRoot: root,
    diagnosticsRoot: root,
    jobId: ids[0],
    retentionDays: 30,
  });
  await current.ready;
  await assert.rejects(stat(expiredPath), { code: "ENOENT" });
});

test("event JSONL respects its configured size cap and marks diagnostics incomplete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "job-diagnostics-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = createJobDiagnostics({
    projectRoot: root,
    jobId: ids[0],
    maxFileBytes: 1024,
  });
  await diagnostics.ready;
  for (let index = 0; index < 30; index++)
    await diagnostics.logger.event({
      stage: "render",
      status: "completed",
      count: index,
    });
  assert.equal((await stat(diagnostics.files.events)).size <= 1024, true);
  assert.equal(diagnostics.diagnosticsIncomplete, true);
});

test("diagnostic retention does not delete an unresolved finalization record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "job-finalization-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = join(root, ids[1]);
  await mkdir(pending);
  await writeFile(join(pending, "finalization-result.json"), "pending");
  const oldTime = new Date(Date.now() - 40 * 86400000);
  await utimes(pending, oldTime, oldTime);
  await createJobDiagnostics({
    projectRoot: root,
    diagnosticsRoot: root,
    jobId: ids[0],
    retentionDays: 30,
  }).ready;
  assert.equal(
    (await stat(join(pending, "finalization-result.json"))).isFile(),
    true,
  );
});
