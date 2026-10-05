import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJobDiagnostics } from "../plugins/audiogram-helper/job-diagnostics.mjs";
import { runAudiogramJobLogsCli } from "./audiogram-job-logs.mjs";

test("lookup returns safe events for one job only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audiogram-job-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = [
    "7bb07aec-e580-4ca4-a2fe-d96bc02b8035",
    "a08c7957-a47f-4e42-8cf7-bbc173183ae9",
  ];
  for (const jobId of ids) {
    const diagnostics = createJobDiagnostics({ projectRoot: root, jobId });
    await diagnostics.logger.event({
      stage: "transcript",
      status: "failed",
      message: "secret",
      url: "https://secret.invalid",
    });
  }
  const stdout = [];
  const stderr = [];
  const exitCode = await runAudiogramJobLogsCli(["--job-id", ids[0]], {
    projectRoot: root,
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  });
  assert.equal(exitCode, 0);
  const output = JSON.parse(stdout.join(""));
  assert.equal(output.events.length, 1);
  assert.equal(output.events[0].jobId, ids[0]);
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.deepEqual(stderr, []);
});

test("lookup validates UUID and reports valid unknown jobs", async () => {
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  };
  assert.equal(
    await runAudiogramJobLogsCli(["--job-id", "../../bad"], { io }),
    1,
  );
  assert.match(stderr.join(""), /UUID/);
  const unknown = "fa28fe18-e8ed-4f40-b02b-63578ba9166d";
  assert.equal(
    await runAudiogramJobLogsCli(["--job-id", unknown], {
      projectRoot: tmpdir(),
      io,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(stdout.at(-1)), { found: false, events: [] });
});
