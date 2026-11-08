import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExplainerRunner } from "./explainer-runner.mjs";
test("background startup failure is visible and scoped to its review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explainer-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  const runner = createExplainerRunner({
    projectRoot: root,
    environment: { AUDIOGRAM_DATA_ROOT: root },
    launch: () => child,
    requestRunner: async (args) => ({
      reviewId: args.reviewId,
      revision: 4,
      state: "script_approved",
    }),
  });
  const started = await runner.run({
    reviewId: "review-a",
    action: "narrate",
    revision: 4,
  });
  child.stderr.emit("data", Buffer.from("Missing configuration"));
  child.emit("close", 1);
  let result;
  for (let i = 0; i < 50; i++) {
    result = await runner.run({
      reviewId: "review-a",
      action: "get",
      operationId: started.operationId,
    });
    if (result.operation.state === "failed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(result.operation.state, "failed");
  assert.match(result.operation.diagnostic, /Missing configuration/);
  await assert.rejects(
    runner.run({
      reviewId: "review-b",
      action: "get",
      operationId: started.operationId,
    }),
    /another review/,
  );
  await assert.rejects(
    runner.run({
      reviewId: "review-a",
      action: "get",
      operationId: "../../secret",
    }),
    /Invalid operation/,
  );
});
