import {
  createPublishingExecution,
  acquireWorkerLock,
} from "./publishing-execution.mjs";
import { runPublishingOnce } from "./publishing-worker.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderTreatmentRun } from "./treatment-runner.mjs";
import {
  hashArtifact,
  enqueueCompletedArtifact,
} from "./publishing-completion.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingServer } from "./publishing-server.mjs";
import { validateCliResult } from "../plugins/audiogram-helper/result-validation.mjs";
import { migrateArtifactStorage } from "./migrate-artifact-storage.mjs";

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "storage-integration-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = join(base, "checkout-a"),
    b = join(base, "checkout-b"),
    data = join(base, "shared");
  await mkdir(a);
  await mkdir(b);
  await mkdir(data);
  return { a, b, data };
}
const treatment = {
  id: "test",
  version: "1",
  compositionId: "Test",
  requiredAssetRoles: [],
  output: { extension: "mp4", codec: "h264" },
  buildProps: () => ({ title: "Synthetic" }),
};

test("render, queue, helper validation and HTTP playback survive producer checkout removal", async (t) => {
  const { a, b, data } = await setup(t);
  const reference = await renderTreatmentRun(
    {
      clipPackage: {
        videoId: "video",
        packageVersion: "1",
        rank: 1,
        assets: [],
      },
      treatment,
    },
    {
      projectRoot: a,
      artifactRoot: data,
      runCommand: async (_, args) => writeFile(args[3], "synthetic-video"),
    },
  );
  const ledger = createPublishingLedger(join(data, "queue.sqlite"));
  t.after(() => ledger.close());
  const item = await enqueueCompletedArtifact({
    ledger,
    projectRoot: a,
    artifactRoot: data,
    artifactRelativePath: reference,
    artifactHash: await hashArtifact(a, reference, { artifactRoot: data }),
    accountId: "local-approval",
    title: "Synthetic",
  });
  await rm(a, { recursive: true });
  assert.deepEqual(
    (
      await validateCliResult(
        { contractVersion: 1, status: "complete", artifactPaths: [reference] },
        b,
        { artifactRoot: data },
      )
    ).artifacts,
    [reference],
  );
  ledger.approveItem(item.id, "2026-10-09T10:00:00Z");
  const execution = createPublishingExecution(join(data, "queue.sqlite"));
  const lock = await acquireWorkerLock(join(data, "queue.sqlite"));
  try {
    const client = {
      verifyAccount: async () => {},
      createContainer: async () => ({
        id: "123",
        uri: "https://rupload.facebook.com/ig-api-upload/v26.0/123",
      }),
      uploadVideo: async ({ fileHandle, size }) => {
        const bytes = Buffer.alloc(size);
        await fileHandle.read(bytes, 0, size, 0);
        assert.equal(bytes.toString(), "synthetic-video");
      },
      getContainerStatus: async () => ({ statusCode: "FINISHED", uploadPhase: "complete", processingPhase: "complete" }),
      publishContainer: async () => ({ id: "456" }),
    };
    const result = await runPublishingOnce({
      ledger,
      execution,
      lock,
      client,
      config: {
        projectRoot: b,
        artifactRoot: data,
        accountId: "local-approval",
        pageId: "1",
        username: "test",
      },
      itemId: item.id,
      now: () => "2026-10-10T10:00:00Z",
      sleep: async () => {},
    });
    assert.equal(result.status, "published");
  } finally {
    await lock.release();
    execution.close();
  }
  const server = createPublishingServer({
    ledger,
    projectRoot: b,
    artifactRoot: data,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/items/${item.id}/preview`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "synthetic-video");
  await rm(join(data, reference));
  const missing = await fetch(
    `http://127.0.0.1:${server.address().port}/api/items/${item.id}/preview`,
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "ARTIFACT_UNAVAILABLE");
});

test("promotion failure returns no artifact and cannot enqueue success", async (t) => {
  const { a, data } = await setup(t);
  await writeFile(join(data, "artifacts"), "blocks storage");
  await assert.rejects(
    renderTreatmentRun(
      {
        clipPackage: {
          videoId: "video",
          packageVersion: "1",
          rank: 1,
          assets: [],
        },
        treatment,
      },
      {
        projectRoot: a,
        artifactRoot: data,
        runCommand: async (_, args) => writeFile(args[3], "video"),
      },
    ),
  );
  await assert.rejects(
    stat(join(a, "out/treatments/test/1/video/1/clip-1.mp4")),
    { code: "ENOENT" },
  );
});

test("legacy migration preserves approval, queue IDs and verified content; rerun is safe", async (t) => {
  const { a, b, data } = await setup(t);
  await mkdir(join(a, "out"), { recursive: true });
  await writeFile(join(a, "out/clip.mp4"), "original-video");
  const queuePath = join(data, "queue.sqlite");
  const ledger = createPublishingLedger(queuePath);
  const hash = await hashArtifact(a, "out/clip.mp4");
  const item = ledger.enqueueArtifact({
    artifactRelativePath: "out/clip.mp4",
    artifactHash: hash,
    accountId: "2",
    caption: "approved",
    title: "Original",
  });
  ledger.approveItem(item.id, "2026-10-10T10:00:00Z");
  const before = ledger.getPublishingItem(item.id);
  ledger.close();
  const processingPath = join(data, "processing.sqlite");
  const db = new DatabaseSync(processingPath);
  db.exec(
    "CREATE TABLE treatment_runs (id INTEGER PRIMARY KEY,status TEXT,artifact_relative_path TEXT)",
  );
  db.prepare("INSERT INTO treatment_runs VALUES(1,?,?)").run(
    "rendered",
    "out/clip.mp4",
  );
  db.close();
  const options = {
    sourceRoots: [a],
    publishingDb: queuePath,
    processingDb: processingPath,
    artifactRoot: data,
  };
  assert.equal((await migrateArtifactStorage(options)).migrated.length, 2);
  const result = await migrateArtifactStorage({ ...options, apply: true });
  assert.equal(result.unresolved.length, 0);
  const afterLedger = createPublishingLedger(queuePath);
  const after = afterLedger.getPublishingItem(item.id);
  afterLedger.close();
  assert.deepEqual(
    { ...after, artifactRelativePath: before.artifactRelativePath },
    before,
  );
  assert.match(after.artifactRelativePath, /^artifacts\//);
  assert.equal(
    (await migrateArtifactStorage({ ...options, apply: true })).migrated.length,
    0,
  );
  await rm(a, { recursive: true });
  assert.equal(
    await hashArtifact(b, after.artifactRelativePath, { artifactRoot: data }),
    hash,
  );
});

test("migration refuses changed source bytes and preserves queue references", async (t) => {
  const { a, data } = await setup(t);
  await mkdir(join(a, "out"));
  await writeFile(join(a, "out/clip.mp4"), "original");
  const queuePath = join(data, "queue.sqlite");
  const ledger = createPublishingLedger(queuePath);
  const item = ledger.enqueueArtifact({
    artifactRelativePath: "out/clip.mp4",
    artifactHash: await hashArtifact(a, "out/clip.mp4"),
    accountId: "local-approval",
    title: "Original",
  });
  ledger.close();
  await writeFile(join(a, "out/clip.mp4"), "changed");
  const result = await migrateArtifactStorage({
    sourceRoots: [a],
    publishingDb: queuePath,
    artifactRoot: data,
    apply: true,
  });
  assert.equal(result.migrated.length, 0);
  assert.equal(result.unresolved.length, 1);
  const check = createPublishingLedger(queuePath);
  assert.equal(
    check.getPublishingItem(item.id).artifactRelativePath,
    "out/clip.mp4",
  );
  check.close();
});

test("interrupted migration reconciles processing references after the producer is removed", async (t) => {
  const { a, data } = await setup(t);
  await mkdir(join(a, "out"));
  await writeFile(join(a, "out/clip.mp4"), "original");
  const queuePath = join(data, "queue.sqlite");
  const ledger = createPublishingLedger(queuePath);
  ledger.enqueueArtifact({
    artifactRelativePath: "out/clip.mp4",
    artifactHash: await hashArtifact(a, "out/clip.mp4"),
    accountId: "local-approval",
    title: "Original",
  });
  ledger.close();
  const processingPath = join(data, "processing.sqlite");
  const db = new DatabaseSync(processingPath);
  db.exec(
    "CREATE TABLE treatment_runs (id INTEGER PRIMARY KEY,status TEXT,artifact_relative_path TEXT); INSERT INTO treatment_runs VALUES(1,'rendered','out/clip.mp4'); CREATE TRIGGER fail_move BEFORE UPDATE ON treatment_runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  const options = {
    sourceRoots: [a],
    publishingDb: queuePath,
    processingDb: processingPath,
    artifactRoot: data,
    apply: true,
  };
  const first = await migrateArtifactStorage(options);
  assert.ok(first.unresolved.length >= 1);
  db.exec("DROP TRIGGER fail_move");
  await rm(a, { recursive: true });
  const second = await migrateArtifactStorage(options);
  assert.equal(second.unresolved.length, 0);
  assert.equal(second.migrated.length, 1);
  assert.match(
    db.prepare("SELECT artifact_relative_path FROM treatment_runs").get()
      .artifact_relative_path,
    /^artifacts\//,
  );
  db.close();
});
