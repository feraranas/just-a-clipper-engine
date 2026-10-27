import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { createJobStore } from "./job-store.mjs";
import {
  persistFinalResult,
  recoverPendingFinalizations,
} from "./mcp-finalization.mjs";

const result = {
  status: "failed",
  artifacts: [],
  failures: [
    {
      stage: "selection",
      code: "SELECTION_FAILED",
      message: "Selection failed.",
    },
  ],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mcp-finalization-"));
  const filename = join(root, "jobs.sqlite");
  const recoveryRoot = join(root, "runs");
  const store = createJobStore(filename);
  const job = store.createOrGetJob({
    videoId: "v",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    filename,
    recoveryRoot,
    store,
    job,
    file: join(recoveryRoot, job.jobId, "finalization-result.json"),
  };
}
const options = (f) => ({
  store: f.store,
  jobId: f.job.jobId,
  result,
  capture: "complete",
  recoveryRoot: f.recoveryRoot,
});

test("finalization persists once, removes recovery file only after commit and rejects conflicting results", async (t) => {
  const f = await fixture(t);
  const first = await persistFinalResult(options(f));
  assert.equal(first.finalized, true);
  assert.equal(f.store.getJob(f.job.jobId).status, "failed");
  await assert.rejects(stat(f.file), { code: "ENOENT" });
  const duplicate = await persistFinalResult(options(f));
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 1);
});

test("persistence outage retains a private durable sidecar and recovery commits without generation", async (t) => {
  const f = await fixture(t);
  const raw = new DatabaseSync(f.filename);
  t.after(() => raw.close());
  raw.exec(
    "CREATE TRIGGER fail_finish BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT,'outage'); END",
  );
  const waits = [];
  const pending = await persistFinalResult({
    ...options(f),
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(pending.finalized, false);
  assert.equal(pending.health, "pending");
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(f.store.getJob(f.job.jobId).status, "queued");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(f.recoveryRoot, f.job.jobId))).mode & 0o777,
    0o700,
  );
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.jobId, f.job.jobId);
  assert.deepEqual(saved.result, result);
  raw.exec("DROP TRIGGER fail_finish");
  let validations = 0;
  const recovery = await recoverPendingFinalizations({
    store: f.store,
    recoveryRoot: f.recoveryRoot,
    validateResult: async (savedResult) => {
      validations++;
      return savedResult;
    },
  });
  assert.equal(recovery.recovered, 1);
  assert.equal(validations, 1);
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 1);
  await assert.rejects(stat(f.file), { code: "ENOENT" });
});

test("missing, malformed, oversized, wrong-job and wrong-selection sidecars cannot finalize", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await recoverPendingFinalizations({
      store: f.store,
      recoveryRoot: f.recoveryRoot,
      validateResult: async (saved) => saved,
    }),
    { recovered: 0, pending: 0, rejected: 0 },
  );
  const store = {
    getJob: f.store.getJob,
    finalizeJob() {
      throw new Error("outage");
    },
  };
  await persistFinalResult({ ...options(f), store, sleep: async () => {} });
  const valid = JSON.parse(await readFile(f.file, "utf8"));
  for (const contents of [
    "{",
    "x".repeat(1024 * 1024 + 1),
    JSON.stringify({ ...valid, jobId: "wrong" }),
    JSON.stringify({ ...valid, sourceUrl: "https://youtu.be/other" }),
    JSON.stringify({ ...valid, renderKey: "other@1" }),
  ]) {
    await writeFile(f.file, contents);
    const recovered = await recoverPendingFinalizations({
      store: f.store,
      recoveryRoot: f.recoveryRoot,
      validateResult: async (saved) => saved,
    });
    assert.equal(recovered.rejected, 1);
    assert.equal(f.store.getJob(f.job.jobId).status, "queued");
  }
});

test("verification failure rejects recovery and never replaces the pending result with processing failure", async (t) => {
  const f = await fixture(t);
  const unavailable = {
    getJob: f.store.getJob,
    finalizeJob() {
      throw new Error("outage");
    },
  };
  await persistFinalResult({
    ...options(f),
    store: unavailable,
    sleep: async () => {},
  });
  const recovered = await recoverPendingFinalizations({
    store: f.store,
    recoveryRoot: f.recoveryRoot,
    validateResult: async () => {
      throw Object.assign(new Error("Media unavailable"), {
        code: "ARTIFACT_UNAVAILABLE",
      });
    },
  });
  assert.equal(recovered.rejected, 1);
  assert.equal(f.store.getJob(f.job.jobId).status, "queued");
  assert.equal((await stat(f.file)).isFile(), true);
  const missingMedia = await recoverPendingFinalizations({
    store: f.store,
    recoveryRoot: f.recoveryRoot,
    validateResult: async () => {
      throw Object.assign(new Error("Media disappeared during verification"), {
        code: "ENOENT",
      });
    },
  });
  assert.equal(missingMedia.rejected, 1);
});

test("crash after commit before sidecar removal reuses one finish on restart", async (t) => {
  const f = await fixture(t);
  const unavailable = {
    getJob: f.store.getJob,
    finalizeJob() {
      throw new Error("outage");
    },
  };
  await persistFinalResult({
    ...options(f),
    store: unavailable,
    sleep: async () => {},
  });
  const first = f.store.finalizeJob(f.job.jobId, result, {
    capture: "complete",
  });
  const recovery = await recoverPendingFinalizations({
    store: f.store,
    recoveryRoot: f.recoveryRoot,
    validateResult: async (saved) => saved,
  });
  assert.equal(recovery.recovered, 1);
  assert.equal(
    f.store.listJobEvents({ jobId: f.job.jobId })[0].eventId,
    first.event.eventId,
  );
});

test("failure of both sidecar and database is not claimed recoverable", async (t) => {
  const f = await fixture(t);
  const badRoot = join(f.root, "not-directory");
  await writeFile(badRoot, "occupied");
  const store = {
    getJob: f.store.getJob,
    finalizeJob() {
      throw new Error("outage");
    },
  };
  const response = await persistFinalResult({
    ...options(f),
    store,
    recoveryRoot: badRoot,
    sleep: async () => {},
  });
  assert.equal(response.finalized, false);
  assert.equal(response.health, "unrecoverable");
  assert.equal(f.store.getJob(f.job.jobId).status, "queued");
});

test("competing finalizers cannot overwrite each other's recovery record or commit two outcomes", async (t) => {
  const f = await fixture(t);
  const other = { status: "no_clips", artifacts: [] };
  const outcomes = await Promise.all([
    persistFinalResult({ ...options(f), sleep: async () => {} }),
    persistFinalResult({ ...options(f), result: other, sleep: async () => {} }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.finalized).length, 1);
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 1);
});

test("a process exit after committed progress preserves the fact without claiming complete capture", async (t) => {
  const f = await fixture(t);
  const storeUrl = new URL("./job-store.mjs", import.meta.url).href;
  const contractUrl = new URL("./mcp-event-contract.mjs", import.meta.url).href;
  const script = `import {createJobStore} from ${JSON.stringify(storeUrl)};
    import {projectStageFact} from ${JSON.stringify(contractUrl)};
    import {randomUUID} from "node:crypto";
    const store=createJobStore(process.argv[1]); const job=store.getJob(process.argv[2]);
    const sourceId=randomUUID(); const fact=projectStageFact({job,sourceId,stageInstanceId:randomUUID(),normalized:{stage:"selection",status:"started"}});
    store.appendProgress({jobId:job.jobId,sourceId,fact}); process.exit(17);`;
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      f.filename,
      f.job.jobId,
    ]),
    { code: 17 },
  );
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 1);
  assert.equal(f.store.getCaptureHealth(f.job.jobId), "unknown");
  const ended = await persistFinalResult({ ...options(f), capture: "unknown" });
  assert.equal(ended.finalized, true);
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 2);
});
