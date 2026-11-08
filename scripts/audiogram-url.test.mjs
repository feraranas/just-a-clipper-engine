import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJobDiagnostics } from "../plugins/audiogram-helper/job-diagnostics.mjs";

import { runAudiogramUrlCli } from "./audiogram-url.mjs";
import { createJobStore } from "../plugins/audiogram-helper/job-store.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

const successResult = {
  contractVersion: 1,
  status: "complete",
  source: {
    videoId: "dQw4w9WgXcQ",
    title: "A source video",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  },
  artifactPaths: ["out/treatments/audiogram-basic/1/dQw4w9WgXcQ/v1/clip-1.mp4"],
};

const makeIO = () => {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  };
};

test("managed CLI process opens its own durable sink, flushes it and returns capture health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cli-child-"));
  const file = join(root, "jobs.sqlite");
  const store = createJobStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = store.createOrGetJob({
    videoId: "video",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  const moduleUrl = new URL("./audiogram-url.mjs", import.meta.url).href;
  const script = `import {runAudiogramUrlCli} from ${JSON.stringify(moduleUrl)};
    await runAudiogramUrlCli(["--url", "https://youtu.be/abcdefghijk", "--job-id", process.env.AUDIOGRAM_JOB_ID],
      {stdout:process.stdout,stderr:process.stderr}, {runPipeline:async ({dependencies})=>{
        await dependencies.onEvent({stage:"transcript",status:"completed"});
        await dependencies.onEvent({stage:"jev",status:"skipped"});
        return {contractVersion:1,status:"no_clips",artifactPaths:[]};
      }});`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        AUDIOGRAM_EVENT_CAPTURE_ENABLED: "1",
        AUDIOGRAM_EVENT_STORE_PATH: file,
        AUDIOGRAM_JOB_ID: job.jobId,
        AUDIOGRAM_RUN_ID: job.jobId,
        AUDIOGRAM_DIAGNOSTICS_ROOT: join(root, "runs"),
      },
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.notificationHealth.capture, "complete");
  const events = store.listJobEvents({ jobId: job.jobId });
  assert.deepEqual(
    events.map((event) => event.data.kind),
    ["stage_completed", "stage_skipped"],
  );
  assert.equal(events[0].data.job_id, job.jobId);
});

test("managed capture rejects mismatched run identity before pipeline execution", async () => {
  const { io, stdout } = makeIO();
  const id = "7bb07aec-e580-4ca4-a2fe-d96bc02b8035";
  let calls = 0;
  await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--job-id", id],
    io,
    {
      environment: {
        AUDIOGRAM_EVENT_CAPTURE_ENABLED: "1",
        AUDIOGRAM_JOB_ID: id,
        AUDIOGRAM_RUN_ID: "11111111-1111-4111-8111-111111111111",
        AUDIOGRAM_EVENT_STORE_PATH: "/tmp/not-opened.sqlite",
      },
      runPipeline: async () => {
        calls++;
        return successResult;
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(JSON.parse(stdout.join("")).status, "failed");
});

test("managed capture rejects a missing stored job instead of running untracked work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cli-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { io, stdout } = makeIO();
  const id = "7bb07aec-e580-4ca4-a2fe-d96bc02b8035";
  let calls = 0;
  await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--job-id", id],
    io,
    {
      environment: {
        AUDIOGRAM_EVENT_CAPTURE_ENABLED: "1",
        AUDIOGRAM_JOB_ID: id,
        AUDIOGRAM_RUN_ID: id,
        AUDIOGRAM_EVENT_STORE_PATH: join(root, "jobs.sqlite"),
      },
      runPipeline: async () => {
        calls++;
        return successResult;
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(JSON.parse(stdout.join("")).status, "failed");
});

test("rejects a missing URL as a usage error without writing JSON", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli([], io);

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /--url/);
});

test("rejects unknown flags as usage errors", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(["--other"], io);

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /other|unknown|option/i);
});

test("with a job ID, CLI creates its own logger and passes it into the pipeline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audiogram-cli-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = "7bb07aec-e580-4ca4-a2fe-d96bc02b8035";
  const { io, stdout } = makeIO();
  let pipelineDependencies;
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--job-id", jobId],
    io,
    {
      projectRoot: root,
      environment: {},
      runPipeline: async (input) => {
        pipelineDependencies = input.dependencies;
        await input.dependencies.onEvent({
          stage: "transcript",
          status: "completed",
        });
        return successResult;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(typeof pipelineDependencies.onEvent, "function");
  const diagnostics = await readJobDiagnostics({ projectRoot: root, jobId });
  assert.equal(diagnostics.events[0].jobId, jobId);
  assert.equal(diagnostics.events[0].stage, "transcript");
  assert.equal(stdout.length, 1);
});

test("CLI retry flag asks the pipeline to reset failed work", async () => {
  const { io } = makeIO();
  let retryFailedPipeline = false;
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--retry"],
    io,
    {
      runPipeline: async (input) => {
        retryFailedPipeline = input.dependencies.retryFailedPipeline;
        return successResult;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(retryFailedPipeline, true);
});

test("CLI rejects malformed job IDs before calling the pipeline", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--job-id", "../../bad"],
    io,
    { runPipeline: async () => assert.fail("invalid job dispatched") },
  );
  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /UUID/i);
});

test("writes exactly one JSON contract for successful processing", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url],
    io,
    { runPipeline: async () => successResult },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, [`${JSON.stringify(successResult)}\n`]);
  assert.deepEqual(stderr, []);
});

test("returns structured terminal failures as JSON while reserving nonzero exit for usage errors", async () => {
  const { io, stdout, stderr } = makeIO();
  const failure = {
    contractVersion: 1,
    status: "failed",
    source: null,
    artifactPaths: [],
    error: { code: "INVALID_HOST", message: "URL host is not supported." },
  };
  const exitCode = await runAudiogramUrlCli(
    ["--url", "https://example.com/video"],
    io,
    { runPipeline: async () => failure },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, [`${JSON.stringify(failure)}\n`]);
  assert.deepEqual(stderr, []);
});

test("converts an unexpected runner exception into one safe structured failure", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url],
    io,
    {
      runPipeline: async () => {
        throw new Error("runner exploded");
      },
    },
  );
  const result = JSON.parse(stdout.join(""));

  assert.equal(exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(result.contractVersion, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "RUNNER_FAILED");
  assert.equal(stderr.length, 0);
});

test("forwards canonical template flags and keeps the JSON result contract", async () => {
  const { io, stdout } = makeIO();
  let received;
  const exitCode = await runAudiogramUrlCli(
    [
      "--url",
      successResult.source.url,
      "--template",
      "classic",
      "--template-version",
      "1",
      "--variation",
      "default",
    ],
    io,
    {
      environment: {},
      runPipeline: async (input) => {
        received = input;
        return successResult;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(received.templateSelection, {
    templateId: "classic",
    templateVersion: "1",
    variationId: "default",
  });
  assert.deepEqual(JSON.parse(stdout.join("")), successResult);
});
test("invalid CLI selection returns a failure without invoking the pipeline", async () => {
  const { io, stdout } = makeIO();
  let calls = 0;
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url, "--variation", "missing"],
    io,
    {
      runPipeline: async () => {
        calls++;
        return successResult;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(calls, 0);
  assert.equal(
    JSON.parse(stdout.join("")).error.code,
    "INVALID_TEMPLATE_SELECTION",
  );
});

test("retry requires an explicit boolean flag", async () => {
  for (const enabled of [false, true]) {
    let captured;
    const { io } = makeIO();
    assert.equal(
      await runAudiogramUrlCli(
        [
          "--url",
          successResult.source.url,
          ...(enabled ? ["--retry-failed-renders"] : []),
        ],
        io,
        {
          runPipeline: async (input) => {
            captured = input;
            return successResult;
          },
        },
      ),
      0,
    );
    assert.equal(captured.retryFailedRenders, enabled);
  }
});
