import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "./job-store.mjs";
import { runJobWorker } from "./job-worker.mjs";
import { DatabaseSync } from "node:sqlite";
import { createLocalRunner } from "./local-runner.mjs";
test("worker sends stored default flags to the real CLI subprocess", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "classic-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, "jobs.sqlite");
  const store = createJobStore(storePath);
  t.after(() => store.close());
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts/audiogram-url.mjs"),
    `import {writeFileSync} from 'node:fs';writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({contractVersion:1,status:'no_clips',source:{title:'Example'},artifactPaths:[]}));`,
  );
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: root,
    jobStorePath: storePath,
  });
  const args = JSON.parse(await readFile(join(root, "args.json"), "utf8"));
  assert.deepEqual(args, [
    "--url",
    job.sourceUrl,
    "--job-id",
    job.jobId,
    "--template",
    "classic",
    "--template-version",
    "1",
    "--variation",
    "default",
  ]);
  assert.equal(store.getJob(job.jobId).status, "no_clips");
});
test("worker rejects supplied selection that differs from persisted job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "classic-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, "jobs.sqlite");
  const store = createJobStore(storePath);
  t.after(() => store.close());
  const { job } = store.createOrGetJob({ videoId: "v", sourceUrl: "url" });
  let calls = 0;
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: "url",
    templateSelection: { variationId: "invalid" },
    projectRoot: root,
    jobStorePath: storePath,
    runCommand: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.equal(store.getJob(job.jobId).status, "failed");
});

test("worker passes managed capture identity to CLI without inheriting the signing key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-event-env-"));
  const storePath = join(root, "jobs.sqlite");
  const store = createJobStore(storePath);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { job } = store.createOrGetJob({
    videoId: "v",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  let received;
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: root,
    jobStorePath: storePath,
    environment: {
      AUDIOGRAM_EVENT_CAPTURE_ENABLED: "1",
      AUDIOGRAM_EVENT_SECRET_KEY: "private-key",
    },
    runCommand: async ({ env }) => {
      received = env;
      return {
        stdout: JSON.stringify({
          contractVersion: 1,
          status: "no_clips",
          artifactPaths: [],
        }),
        stderr: "",
      };
    },
  });
  assert.equal(received.AUDIOGRAM_EVENT_SECRET_KEY, undefined);
  assert.equal(received.AUDIOGRAM_EVENT_STORE_PATH, storePath);
  assert.equal(received.AUDIOGRAM_JOB_ID, job.jobId);
  assert.equal(received.AUDIOGRAM_RUN_ID, job.jobId);
});

test("verified worker success survives a finish-store outage and stale lookup recovers without another CLI call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-finalization-"));
  const file = join(root, "jobs.sqlite");
  const store = createJobStore(file);
  const raw = new DatabaseSync(file);
  t.after(async () => {
    raw.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.markRunning(job.jobId, 12345);
  await mkdir(join(root, "out", "treatments"), { recursive: true });
  await writeFile(
    join(root, "out", "treatments", "video.mp4"),
    "verified-video",
  );
  raw.exec(
    "CREATE TRIGGER fail_finish BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT,'outage'); END",
  );
  let calls = 0;
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: root,
    jobStorePath: file,
    finalizationSleep: async () => {},
    runCommand: async () => {
      calls++;
      return {
        stdout: JSON.stringify({
          contractVersion: 1,
          status: "complete",
          source: { videoId: job.videoId, title: "Video" },
          artifactPaths: ["out/treatments/video.mp4"],
          notificationHealth: { capture: "complete" },
        }),
        stderr: "",
      };
    },
  });
  assert.equal(store.getJob(job.jobId).status, "running");
  const pending = JSON.parse(
    await readFile(
      join(
        root,
        ".local",
        "audiogram-helper",
        "runs",
        job.jobId,
        "finalization-result.json",
      ),
      "utf8",
    ),
  );
  assert.equal(pending.result.status, "complete");
  raw.exec("DROP TRIGGER fail_finish");
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: root,
    isProcessAlive: () => false,
  });
  await writeFile(
    join(root, "out", "treatments", "video.mp4"),
    "changed-video",
  );
  await assert.rejects(runner.getStatus(job.jobId), {
    code: "FINALIZATION_PENDING",
  });
  assert.equal(store.getJob(job.jobId).status, "running");
  assert.equal(store.listJobEvents({ jobId: job.jobId }).length, 0);
  await writeFile(
    join(root, "out", "treatments", "video.mp4"),
    "verified-video",
  );
  const status = await runner.getStatus(job.jobId);
  assert.equal(status.status, "complete");
  assert.equal(calls, 1);
  assert.equal(
    store.listJobEvents({ jobId: job.jobId, name: "audiogram.job.finished" })
      .length,
    1,
  );
});

test("deleted or changed finalized artifacts report availability errors without changing the processing result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-availability-"));
  const storePath = join(root, "jobs.sqlite");
  const store = createJobStore(storePath);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { job } = store.createOrGetJob({ videoId: "v", sourceUrl: "url" });
  await mkdir(join(root, "out", "treatments"), { recursive: true });
  const media = join(root, "out", "treatments", "video.mp4");
  await writeFile(media, "original");
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: "url",
    projectRoot: root,
    jobStorePath: storePath,
    runCommand: async () => ({
      stdout: JSON.stringify({
        contractVersion: 1,
        status: "complete",
        artifactPaths: ["out/treatments/video.mp4"],
      }),
      stderr: "",
    }),
  });
  const original = store.getJob(job.jobId).result;
  const runner = createLocalRunner({ jobStore: store, projectRoot: root });
  await writeFile(media, "modified");
  await assert.rejects(runner.getStatus(job.jobId), {
    code: "ARTIFACT_UNAVAILABLE",
  });
  await rm(media);
  await assert.rejects(runner.getStatus(job.jobId), {
    code: "ARTIFACT_UNAVAILABLE",
  });
  assert.deepEqual(store.getJob(job.jobId).result, original);
  assert.equal(store.getJob(job.jobId).status, "complete");
  assert.equal(store.listJobEvents({ jobId: job.jobId }).length, 1);
});

test("completion on a second connection wins over a stale status snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-stale-race-"));
  const file = join(root, "jobs.sqlite");
  const store = createJobStore(file);
  const other = createJobStore(file);
  t.after(async () => {
    other.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { job } = store.createOrGetJob({ videoId: "v", sourceUrl: "url" });
  store.markRunning(job.jobId, 98765);
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: root,
    isProcessAlive: () => {
      other.finalizeJob(
        job.jobId,
        { status: "no_clips", artifacts: [] },
        { capture: "unknown" },
      );
      return false;
    },
  });
  const status = await runner.getStatus(job.jobId);
  assert.equal(status.status, "no_clips");
  assert.equal(store.getJob(job.jobId).status, "no_clips");
  assert.equal(store.listJobEvents({ jobId: job.jobId }).length, 1);
});

test("partial CLI result without failures is a contract error, not stranded finalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-invalid-partial-"));
  const storePath = join(root, "jobs.sqlite");
  const store = createJobStore(storePath);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { job } = store.createOrGetJob({ videoId: "v", sourceUrl: "url" });
  await mkdir(join(root, "out", "treatments"), { recursive: true });
  await writeFile(join(root, "out", "treatments", "video.mp4"), "video");
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: "url",
    projectRoot: root,
    jobStorePath: storePath,
    runCommand: async () => ({
      stdout: JSON.stringify({
        contractVersion: 1,
        status: "partial",
        artifactPaths: ["out/treatments/video.mp4"],
        failures: [],
      }),
      stderr: "",
    }),
  });
  assert.equal(store.getJob(job.jobId).status, "failed");
  assert.equal(
    store.getJob(job.jobId).result.failures[0].code,
    "CLI_CONTRACT_INVALID",
  );
});
