import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJobStore } from "./job-store.mjs";
import { createLocalRunner } from "./local-runner.mjs";
import { boundProcessOutput, runJobWorker } from "./job-worker.mjs";
import { startMcpServer } from "./server.mjs";

const scratch = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audiogram-mcp-"));
  scratch.push(dir);
  return dir;
}
afterEach(async () =>
  Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

test("job store deduplicates an active video and persists status across reopen", async () => {
  const dir = await tempDir();
  const filename = path.join(dir, "jobs.sqlite");
  let store = createJobStore(filename);
  const first = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  const duplicate = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.jobId, first.job.jobId);
  await store.markRunning(first.job.jobId, 4321);
  await store.setResult(first.job.jobId, {
    status: "complete",
    title: "Talk",
    artifacts: ["out/treatments/a.mp4"],
  });
  store.close();
  store = createJobStore(filename);
  assert.equal((await store.getJob(first.job.jobId)).status, "complete");
  store.close();
});

test("job store creates a linked retry only from failed or partial terminal jobs", async () => {
  const dir = await tempDir();
  const filename = path.join(dir, "jobs.sqlite");
  const store = createJobStore(filename);
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.setResult(job.jobId, {
    status: "failed",
    failures: [{ stage: "render", code: "RENDER_FAILED" }],
  });
  const retried = store.createRetryJob({ priorJobId: job.jobId });
  assert.equal(retried.created, true);
  assert.notEqual(retried.job.jobId, job.jobId);
  assert.equal(retried.job.retryOfJobId, job.jobId);
  assert.equal(retried.job.sourceUrl, job.sourceUrl);
  assert.equal(retried.job.videoId, job.videoId);
  store.setResult(retried.job.jobId, {
    status: "partial",
    artifacts: ["out/treatments/clip.mp4"],
  });
  const secondRetry = store.createRetryJob({ priorJobId: retried.job.jobId });
  assert.equal(secondRetry.job.retryOfJobId, retried.job.jobId);
  store.setResult(secondRetry.job.jobId, { status: "complete", artifacts: [] });
  assert.throws(
    () => store.createRetryJob({ priorJobId: secondRetry.job.jobId }),
    /terminal failed or partial/,
  );
  const active = store.createOrGetJob({
    videoId: "lmnopqrstuv",
    sourceUrl: "https://youtu.be/lmnopqrstuv",
  }).job;
  assert.throws(
    () => store.createRetryJob({ priorJobId: active.jobId }),
    /terminal failed or partial/,
  );
  assert.throws(
    () => store.createRetryJob({ priorJobId: randomUUID() }),
    /not found/,
  );
  store.close();
});

test("job store migrates the old jobs schema without changing saved jobs", async () => {
  const dir = await tempDir();
  const filename = path.join(dir, "legacy.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, source_url TEXT NOT NULL,
    status TEXT NOT NULL, pid INTEGER, result_json TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO jobs(job_id,video_id,source_url,status) VALUES(?,?,?,?)",
  ).run(id, "abcdefghijk", "https://youtu.be/abcdefghijk", "failed");
  db.close();
  const store = createJobStore(filename);
  assert.equal(store.getJob(id).status, "failed");
  const retried = store.createRetryJob({ priorJobId: id });
  assert.equal(retried.job.retryOfJobId, id);
  store.close();
});

test("runner launches detached worker with argument array and reports queued status", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const calls = [];
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    workerPath: "/project/plugins/audiogram-helper/job-worker.mjs",
    spawnProcess: (...args) => {
      calls.push(args);
      return { pid: 1234, unref() {} };
    },
    isProcessAlive: () => true,
  });
  const result = await runner.start({
    url: "https://youtu.be/abcdefghijk",
    videoId: "abcdefghijk",
  });
  assert.equal(result.status, "running");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    "/project/plugins/audiogram-helper/job-worker.mjs",
    "--job-id",
    result.jobId,
    "--url",
    "https://youtu.be/abcdefghijk",
    "--template",
    "classic",
    "--template-version",
    "1",
    "--variation",
    "default",
  ]);
  assert.equal(calls[0][2].cwd, dir);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].stdio[0], "ignore");
  assert.equal(typeof calls[0][2].stdio[1], "number");
  assert.equal(typeof calls[0][2].stdio[2], "number");
  assert.equal(
    calls[0][2].env.AUDIOGRAM_DIAGNOSTICS_ROOT,
    path.join(dir, ".local", "audiogram-helper", "runs"),
  );
  store.close();
});

test("runner starts the worker when diagnostics files cannot be created", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const diagnosticsRoot = path.join(dir, "not-a-directory");
  await writeFile(diagnosticsRoot, "file blocks diagnostics directory");
  let launch;
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    workerPath: path.join(dir, "worker.mjs"),
    diagnosticsRoot,
    isProcessAlive: () => true,
    spawnProcess: (_command, _args, options) => {
      launch = options;
      const child = new EventEmitter();
      child.pid = 12345;
      child.unref = () => {};
      return child;
    },
  });

  const result = await runner.start({
    videoId: "abcdefghijk",
    url: "https://youtu.be/abcdefghijk",
  });

  assert.equal(result.status, "running");
  assert.ok(launch);
  assert.deepEqual(launch.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(launch.env.AUDIOGRAM_DIAGNOSTICS_INCOMPLETE, "1");
  store.close();
});

test("worker completes the job and marks diagnostics incomplete when the diagnostics root is unavailable", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const diagnosticsRoot = path.join(dir, "not-a-directory");
  await writeFile(diagnosticsRoot, "file blocks diagnostics directory");
  const store = createJobStore(storePath);
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    diagnosticsRoot,
    environment: { AUDIOGRAM_DIAGNOSTICS_ROOT: diagnosticsRoot },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end(
          JSON.stringify({
            contractVersion: 1,
            status: "no_clips",
            source: { videoId: "abcdefghijk", title: "Talk" },
            artifactPaths: [],
          }),
        );
        child.stderr.end("diagnostic output");
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    },
  });

  const result = store.getJob(job.jobId).result;
  assert.equal(result.status, "no_clips");
  assert.equal(result.diagnosticsIncomplete, true);
  store.close();
});

test("worker parses the stable CLI contract and persists terminal state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const store = createJobStore(storePath);
  const { job } = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  let processContract;
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    runCommand: async (input) => {
      processContract = input;
      return {
        stdout: JSON.stringify({
          contractVersion: 1,
          status: "no_clips",
          source: {
            videoId: "abcdefghijk",
            title: "Talk",
            url: "https://youtu.be/abcdefghijk",
          },
          artifactPaths: [],
        }),
        stderr: "",
      };
    },
  });
  assert.equal((await store.getJob(job.jobId)).status, "no_clips");
  assert.deepEqual(processContract.args.slice(3, 5), ["--job-id", job.jobId]);
  assert.equal(
    processContract.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
    path.join(dir, ".local", "audiogram-helper", "runs"),
  );
  store.close();
});

test("worker marks a linked retry for the CLI pipeline", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const store = createJobStore(storePath);
  const { job: prior } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.setResult(prior.jobId, {
    status: "failed",
    artifacts: [],
    error: "failed",
  });
  const { job: retry } = store.createRetryJob({ priorJobId: prior.jobId });
  let processContract;
  await runJobWorker({
    jobId: retry.jobId,
    sourceUrl: retry.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    runCommand: async (input) => {
      processContract = input;
      return {
        stdout: JSON.stringify({
          contractVersion: 1,
          status: "no_clips",
          source: { videoId: "abcdefghijk", title: "Talk" },
          artifactPaths: [],
        }),
        stderr: "",
      };
    },
  });
  assert.ok(processContract.args.includes("--retry"));
  store.close();
});

test("worker keeps the CLI diagnostics-incomplete flag", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const store = createJobStore(storePath);
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    runCommand: async () => ({
      stdout: JSON.stringify({
        contractVersion: 1,
        status: "no_clips",
        source: { videoId: "abcdefghijk", title: "Talk" },
        artifactPaths: [],
        diagnosticsIncomplete: true,
      }),
      stderr: "",
      diagnosticsIncomplete: false,
    }),
  });
  assert.equal(store.getJob(job.jobId).result.diagnosticsIncomplete, true);
  store.close();
});

test("worker records malformed CLI output as failed", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const store = createJobStore(storePath);
  const { job } = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    runCommand: async () => ({ stdout: "not json", stderr: "" }),
  });
  const failed = store.getJob(job.jobId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result.failures[0].code, "CLI_CONTRACT_INVALID");
  store.close();
});

test("worker labels readable but invalid CLI contracts as contract failures", async (t) => {
  const contracts = [
    {
      contractVersion: 2,
      status: "no_clips",
      source: { title: "Talk" },
      artifactPaths: [],
    },
    {
      contractVersion: 1,
      status: "complete",
      source: { title: "Talk" },
      artifactPaths: [],
    },
  ];
  for (const contract of contracts) {
    await t.test(
      `contract version ${contract.contractVersion}, status ${contract.status}`,
      async () => {
        const dir = await tempDir();
        const storePath = path.join(dir, "jobs.sqlite");
        const store = createJobStore(storePath);
        const { job } = store.createOrGetJob({
          videoId: "abcdefghijk",
          sourceUrl: "https://youtu.be/abcdefghijk",
        });
        await runJobWorker({
          jobId: job.jobId,
          sourceUrl: job.sourceUrl,
          projectRoot: dir,
          jobStorePath: storePath,
          runCommand: async () => ({
            stdout: JSON.stringify(contract),
            stderr: "",
          }),
        });
        const failure = store.getJob(job.jobId).result.failures[0];
        assert.equal(failure.stage, "worker");
        assert.equal(failure.code, "CLI_CONTRACT_INVALID");
        assert.equal(failure.message, "The CLI result was invalid.");
        store.close();
      },
    );
  }
});

test("worker records command failure and nonzero exit as failed", async (t) => {
  for (const commandError of [
    new Error("spawn failed"),
    Object.assign(new Error("CLI exited"), { code: 1 }),
  ]) {
    await t.test(commandError.message, async () => {
      const dir = await tempDir();
      const storePath = path.join(dir, "jobs.sqlite");
      const store = createJobStore(storePath);
      const { job } = await store.createOrGetJob({
        videoId: "abcdefghijk",
        sourceUrl: "https://youtu.be/abcdefghijk",
      });
      await runJobWorker({
        jobId: job.jobId,
        sourceUrl: job.sourceUrl,
        projectRoot: dir,
        jobStorePath: storePath,
        runCommand: async () => {
          throw commandError;
        },
      });
      const failed = store.getJob(job.jobId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.result.failures[0].stage, "worker");
      assert.equal(failed.result.failures[0].code, "WORKER_PROCESS_FAILED");
      store.close();
    });
  }
});

test("worker streams bounded CLI stdout and stderr to the job files", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "jobs.sqlite");
  const store = createJobStore(storePath);
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  const childContract = {
    contractVersion: 1,
    status: "no_clips",
    source: { videoId: "abcdefghijk", title: "Talk" },
    artifactPaths: [],
  };
  let commandArgs;
  await runJobWorker({
    jobId: job.jobId,
    sourceUrl: job.sourceUrl,
    projectRoot: dir,
    jobStorePath: storePath,
    environment: { AUDIOGRAM_DIAGNOSTICS_MAX_FILE_BYTES: "1024" },
    spawnProcess: (_command, args, options) => {
      commandArgs = { args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end(JSON.stringify(childContract));
        child.stderr.end("diagnostic ".repeat(300));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  const updated = store.getJob(job.jobId);
  assert.equal(updated.status, "no_clips");
  assert.equal(updated.result.diagnosticsIncomplete, true);
  assert.deepEqual(commandArgs.args.slice(3, 5), ["--job-id", job.jobId]);
  assert.equal(
    commandArgs.options.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
    path.join(dir, ".local", "audiogram-helper", "runs"),
  );
  const diagnosticsDir = path.join(
    dir,
    ".local",
    "audiogram-helper",
    "runs",
    job.jobId,
  );
  assert.equal(
    (await readFile(path.join(diagnosticsDir, "pipeline.stdout.log"), "utf8"))
      .length > 0,
    true,
  );
  assert.equal(
    (await readFile(path.join(diagnosticsDir, "pipeline.stderr.log"), "utf8"))
      .length,
    1024,
  );
  store.close();
});

test("worker stdout and stderr writers stop at the per-stream cap", () => {
  const makeStream = () => {
    const chunks = [];
    return {
      chunks,
      write(chunk, callback) {
        chunks.push(Buffer.from(chunk));
        callback?.();
        return true;
      },
    };
  };
  const stdout = makeStream();
  const stderr = makeStream();
  const incomplete = boundProcessOutput({ stdout, stderr, maxFileBytes: 8 });
  stdout.write("stdout exceeds cap");
  stderr.write("stderr exceeds cap");
  assert.equal(Buffer.concat(stdout.chunks).length, 8);
  assert.equal(Buffer.concat(stderr.chunks).length, 8);
  assert.equal(incomplete(), true);
});

test("runner marks a stale running job failed rather than claiming it is complete", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const { job } = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.markRunning(job.jobId, 9876);
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    isProcessAlive: () => false,
  });
  const status = await runner.getStatus(job.jobId);
  assert.equal(status.status, "failed");
  assert.deepEqual(status.artifacts, []);
  assert.equal(status.failures[0].stage, "worker");
  assert.equal(status.failures[0].code, "WORKER_PROCESS_FAILED");
  store.close();
});

test("runner returns the job ID and a safe worker failure when spawn fails", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    workerPath: "/worker.mjs",
    spawnProcess: () => {
      throw new Error("private spawn detail");
    },
  });
  const status = await runner.start({
    url: "https://youtu.be/abcdefghijk",
    videoId: "abcdefghijk",
  });
  assert.equal(status.status, "failed");
  assert.equal(typeof status.jobId, "string");
  assert.equal(status.failures[0].code, "WORKER_START_FAILED");
  assert.equal(JSON.stringify(status).includes("private spawn detail"), false);
  store.close();
});

test("runner retry creates a new linked job and does not dispatch for ineligible jobs", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const prior = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  store.setResult(prior.jobId, {
    status: "failed",
    title: null,
    artifacts: [],
    failures: [
      {
        stage: "transcript",
        code: "TRANSCRIPT_FAILED",
        message: "Transcript failed.",
      },
    ],
  });
  const launches = [];
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    workerPath: "/worker.mjs",
    spawnProcess: (...args) => {
      launches.push(args);
      return { pid: 771, unref() {} };
    },
    isProcessAlive: () => true,
  });
  const retry = await runner.retry({ jobId: prior.jobId });
  assert.equal(retry.retryOfJobId, prior.jobId);
  assert.notEqual(retry.jobId, prior.jobId);
  assert.equal(launches.length, 1);
  assert.throws(
    () => store.createRetryJob({ priorJobId: retry.jobId }),
    /terminal failed or partial/,
  );
  store.close();
});

test("runner status exposes safe failure details and omits raw error text", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.setResult(job.jobId, {
    status: "failed",
    error: "private api_key=sk-secret transcript words",
    failures: [
      {
        stage: "transcript",
        code: "TRANSCRIPT_FAILED",
        message: "Transcript acquisition failed.",
      },
    ],
  });
  const runner = createLocalRunner({ jobStore: store, projectRoot: dir });
  const status = await runner.getStatus(job.jobId);
  assert.equal(status.failures[0].stage, "transcript");
  assert.equal(status.error, "Transcript acquisition failed.");
  assert.equal(JSON.stringify(status).includes("sk-secret"), false);
  assert.equal(JSON.stringify(status).includes("transcript words"), false);
  store.close();
});

test("runner status preserves the no-clips explanation", async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const { job } = store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  store.setResult(job.jobId, {
    status: "no_clips",
    title: "Talk",
    artifacts: [],
    error: "No clips were selected from this video.",
  });
  const runner = createLocalRunner({ jobStore: store, projectRoot: dir });

  const status = await runner.getStatus(job.jobId);

  assert.equal(status.status, "no_clips");
  assert.equal(status.error, "No clips were selected from this video.");
  store.close();
});

test("MCP rejects unsupported URLs before runner dispatch and exposes create/status tools", async () => {
  const calls = [];
  const runner = {
    start: async (input) => {
      calls.push(input);
      return { jobId: "job-1", status: "queued" };
    },
    getStatus: async () => ({ jobId: "job-1", status: "queued" }),
    retry: async () => ({ jobId: randomUUID(), status: "running" }),
  };
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "create_audiogram",
      "get_audiogram_status",
      "list_video_templates",
      "retry_audiogram",
    ]);
    assert.match(
      tools.tools.find((tool) => tool.name === "retry_audiogram").description,
      /Ask the user.*approval/i,
    );
    const listing = await client.callTool({
      name: "list_video_templates",
      arguments: {},
    });
    assert.equal(listing.structuredContent.contractVersion, 1);
    assert.equal(listing.structuredContent.templates[0].name, "Classic V1");
    assert.deepEqual(listing.structuredContent.templates[0].defaultSelection, {
      templateId: "classic",
      templateVersion: "1",
      variationId: "default",
    });
    assert.match(listing.content[0].text, /Classic V1/);
    assert.equal(calls.length, 0);
    const repeatedListing = await client.callTool({
      name: "list_video_templates",
      arguments: {},
    });
    assert.deepEqual(
      repeatedListing.structuredContent,
      listing.structuredContent,
    );
    const unexpectedInput = await client.callTool({
      name: "list_video_templates",
      arguments: { url: "https://youtu.be/abcdefghijk" },
    });
    assert.equal(unexpectedInput.isError, true);
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(listing).includes("compositionId"), false);
    assert.equal(
      tools.tools.find((t) => t.name === "list_video_templates").annotations
        .readOnlyHint,
      true,
    );
    const invalid = await client.callTool({
      name: "create_audiogram",
      arguments: { url: "https://example.com/video" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
    const invalidTemplate = await client.callTool({
      name: "create_audiogram",
      arguments: { url: "https://youtu.be/abcdefghijk", templateId: "missing" },
    });
    assert.equal(invalidTemplate.isError, true);
    assert.equal(calls.length, 0);
    const accepted = await client.callTool({
      name: "create_audiogram",
      arguments: { url: "https://youtu.be/abcdefghijk" },
    });
    assert.equal(accepted.structuredContent.status, "queued");
    assert.deepEqual(calls[0].templateSelection, {
      templateId: "classic",
      templateVersion: "1",
      variationId: "default",
    });
    const statusId = "88f72107-f36c-4eac-990d-44e64dc6a4cc";
    runner.getStatus = async () => ({
      jobId: statusId,
      status: "running",
      artifacts: [],
    });
    const status = await client.callTool({
      name: "get_audiogram_status",
      arguments: { jobId: statusId },
    });
    assert.equal(status.structuredContent.jobId, statusId);
    runner.getStatus = async () => ({
      jobId: statusId,
      status: "failed",
      artifacts: [],
      failures: [
        {
          stage: "setup",
          code: "PIPELINE_SETUP_FAILED",
          message: "Audiogram processing could not be configured.",
        },
      ],
    });
    const setupFailure = await client.callTool({
      name: "get_audiogram_status",
      arguments: { jobId: statusId },
    });
    assert.deepEqual(setupFailure.structuredContent.failures, [
      {
        stage: "setup",
        code: "PIPELINE_SETUP_FAILED",
        message: "Audiogram processing could not be configured.",
      },
    ]);
    runner.getStatus = async () => ({
      jobId: statusId,
      status: "failed",
      artifacts: [],
      failures: [{
        stage: "selection",
        code: "SELECTION_INVALID_CUE",
        message: "Clip selection referenced a cue that is not in the transcript.",
      }],
    });
    const selectionFailure = await client.callTool({
      name: "get_audiogram_status",
      arguments: { jobId: statusId },
    });
    assert.notEqual(selectionFailure.isError, true);
    assert.equal(selectionFailure.structuredContent.failures[0].code, "SELECTION_INVALID_CUE");
    assert.equal(selectionFailure.structuredContent.failures[0].stage, "selection");
    const retried = await client.callTool({
      name: "retry_audiogram",
      arguments: { jobId: statusId },
    });
    assert.equal(retried.structuredContent.status, "running");
    assert.match(retried.content[0].text, /retry/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("server binds loopback and rejects hostile Host headers", async () => {
  const runner = {
    start: async () => ({ jobId: randomUUID(), status: "queued" }),
    getStatus: async () => null,
  };
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  try {
    assert.equal(server.address.address, "127.0.0.1");
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        server.url,
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
        },
        (response) => resolve(response),
      );
      request.on("error", reject);
      request.end("{}");
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await server.close();
  }
});

test("server rejects malformed JSON without passing it to the MCP handler", async () => {
  const runner = {
    start: async () => assert.fail("malformed request dispatched"),
    getStatus: async () => null,
  };
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        server.url,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => resolve(response),
      );
      request.on("error", reject);
      request.end("{not-json");
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await server.close();
  }
});

test("result artifact paths must be existing nonempty mp4 files under treatments", async () => {
  const dir = await tempDir();
  const treatmentDir = path.join(dir, "out", "treatments");
  await mkdir(treatmentDir, { recursive: true });
  await writeFile(
    path.join(treatmentDir, "clip.mp4"),
    Buffer.from([0, 0, 0, 1]),
  );
  const store = createJobStore(path.join(dir, "jobs.sqlite"));
  const { job } = await store.createOrGetJob({
    videoId: "abcdefghijk",
    sourceUrl: "https://youtu.be/abcdefghijk",
  });
  const runner = createLocalRunner({
    jobStore: store,
    projectRoot: dir,
    spawnProcess: () => ({ pid: 321, unref() {} }),
  });
  await store.setResult(job.jobId, {
    status: "complete",
    title: "Talk",
    artifacts: ["out/treatments/clip.mp4"],
  });
  assert.equal(
    (await runner.getStatus(job.jobId)).artifacts[0],
    "out/treatments/clip.mp4",
  );
  await store.setResult(job.jobId, {
    status: "partial",
    title: "Talk",
    artifacts: ["out/treatments/clip.mp4"],
    failures: [
      {
        stage: "render",
        code: "RENDER_FAILED",
        message: "One clip failed.",
        packageId: 4,
      },
    ],
  });
  const partial = await runner.getStatus(job.jobId);
  assert.equal(partial.status, "partial");
  assert.equal(partial.artifacts.length, 1);
  assert.equal(partial.failures[0].packageId, "4");
  await store.setResult(job.jobId, {
    status: "complete",
    title: "Talk",
    artifacts: ["out/treatments/../../secret.mp4"],
  });
  assert.equal((await runner.getStatus(job.jobId)).status, "failed");
  await writeFile(path.join(treatmentDir, "empty.mp4"), Buffer.alloc(0));
  await store.setResult(job.jobId, {
    status: "complete",
    title: "Talk",
    artifacts: ["out/treatments/empty.mp4"],
  });
  assert.equal((await runner.getStatus(job.jobId)).status, "failed");
  await store.setResult(job.jobId, {
    status: "complete",
    title: "Talk",
    artifacts: ["out/treatments/missing.mp4"],
  });
  assert.equal((await runner.getStatus(job.jobId)).status, "failed");
  store.close();
});

test("MCP discovery fails safely for invalid catalog without runner calls", async () => {
  const runner = {
    start: () => assert.fail("listing started a job"),
    getStatus: () => assert.fail("listing read job state"),
    retry: () => assert.fail("listing retried a job"),
  };
  const server = await startMcpServer({
    projectRoot: process.cwd(),
    runner,
    port: 0,
    templateCatalog: [{ id: "private/path" }],
  });
  const client = new Client({ name: "discovery-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const result = await client.callTool({
      name: "list_video_templates",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /catalog is invalid or unavailable/);
    assert.equal(JSON.stringify(result).includes("private/path"), false);
  } finally {
    await client.close();
    await server.close();
  }
});
