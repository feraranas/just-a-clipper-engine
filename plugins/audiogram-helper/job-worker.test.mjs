import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "./job-store.mjs";
import { runJobWorker } from "./job-worker.mjs";
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
