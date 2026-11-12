import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { queueExplainer } from "./explainer/publishing.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "explainer-queue-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project"),
    data = join(root, "data"),
    review = "12345678-1234-1234-1234-123456789abc";
  const folder = join(
    data,
    "explainers",
    review,
    "12345678-1234-1234-1234-123456789abd",
  );
  await mkdir(folder, { recursive: true });
  await mkdir(projectRoot);
  const path = join(folder, "video.mp4"),
    bytes = Buffer.from("a rendered video");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const p = {
    revision: 3,
    state: "rendered",
    render: { hash: "render" },
    script: { hash: "script" },
    audio: { hash: "audio" },
    plan: { hash: "plan" },
    scriptApproval: "script",
    audioApproval: "audio-hash",
  };
  const values = {
    render: {
      path,
      sha256,
      scriptHash: "script",
      audioSha256: "audio-hash",
      sceneHash: "plan",
    },
    script: { title: "Explainer" },
    audio: { sha256: "audio-hash" },
  };
  const workflow = {
    get: () => ({ ...p }),
    load: async (ref) => values[ref.hash],
    dir: () => join(data, "explainers", review),
  };
  const environment = {
    AUDIOGRAM_DATA_ROOT: data,
    AUDIOGRAM_ARTIFACT_ROOT: join(root, "artifacts"),
    INSTAGRAM_ACCOUNT_ID: "123",
  };
  return { root, data, review, p, values, workflow, environment, projectRoot };
}

test("completed explainer is queued once without approval and survives a retry", async (t) => {
  const x = await fixture(t);
  const args = {
    workflow: x.workflow,
    reviewId: x.review,
    revision: 3,
    projectRoot: x.projectRoot,
    environment: x.environment,
  };
  const a = await queueExplainer(args),
    b = await queueExplainer(args);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "queued");
  const ledger = createPublishingLedger(
    join(x.data, "instagram-publishing.sqlite"),
  );
  try {
    const item = ledger.getPublishingItem(a.id);
    assert.equal(item.accountId, "123");
    assert.equal(item.approvedAt, null);
    assert.match(item.artifactRelativePath, /^artifacts\//);
  } finally {
    ledger.close();
  }
});

test("refuses stale revisions, changed video bytes, and mismatched approvals", async (t) => {
  const x = await fixture(t);
  const args = {
    workflow: x.workflow,
    reviewId: x.review,
    revision: 3,
    projectRoot: x.projectRoot,
    environment: x.environment,
  };
  await assert.rejects(
    queueExplainer({ ...args, revision: 2 }),
    /current completed/,
  );
  x.p.scriptApproval = "different";
  await assert.rejects(queueExplainer(args), /provenance/);
  x.p.scriptApproval = "script";
  await writeFile(x.values.render.path, "tampered");
  await assert.rejects(queueExplainer(args), /hash/);
});

test("refuses reassigning an existing artifact to a different account", async (t) => {
  const x = await fixture(t);
  const args = {
    workflow: x.workflow,
    reviewId: x.review,
    revision: 3,
    projectRoot: x.projectRoot,
    environment: x.environment,
  };
  await queueExplainer(args);
  await assert.rejects(
    queueExplainer({
      ...args,
      environment: { ...x.environment, INSTAGRAM_ACCOUNT_ID: "456" },
    }),
    /different account/,
  );
});
