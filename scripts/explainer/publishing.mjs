import { realpath, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { storeArtifact } from "../artifact-store.mjs";
import { enqueueCompletedArtifact } from "../publishing-completion.mjs";
import { createPublishingLedger } from "../publishing-ledger.mjs";
import { resolvePublishingAccountId } from "../publishing-config.mjs";
import { resolveStorageConfig } from "../storage-config.mjs";

// Registration is local and does not approve or publish. Retrying is idempotent.
export async function queueExplainer({
  workflow,
  reviewId,
  revision,
  projectRoot,
  environment = process.env,
}) {
  const before = workflow.get(reviewId);
  if (
    before.state !== "rendered" ||
    before.revision !== revision ||
    before.pending ||
    !before.render
  )
    throw Error("Refresh the current completed render before queueing");
  const render = await workflow.load(before.render);
  const script = await workflow.load(before.script);
  const audio = await workflow.load(before.audio);
  if (
    before.scriptApproval !== before.script.hash ||
    before.audioApproval !== audio.sha256 ||
    render.scriptHash !== before.script.hash ||
    render.audioSha256 !== audio.sha256 ||
    render.sceneHash !== before.plan?.hash ||
    !/^[a-f0-9]{64}$/.test(render.sha256)
  )
    throw Error("Render provenance does not match current approvals");
  const folder = await realpath(workflow.dir(reviewId));
  const file = resolve(render.path);
  const rel = relative(folder, file);
  if (
    !/^[a-f0-9-]{36}\/video\.mp4$/.test(rel) ||
    rel.startsWith(`..${sep}`) ||
    (await lstat(dirname(file))).isSymbolicLink() ||
    (await lstat(file)).isSymbolicLink() ||
    (await realpath(file)) !== file
  )
    throw Error("Invalid explainer render path");
  const config = resolveStorageConfig(environment);
  const artifactHash = `sha256:${render.sha256}`;
  const artifactRelativePath = await storeArtifact({
    projectRoot,
    videoPath: file,
    artifactRoot: config.artifactRoot,
    expectedHash: artifactHash,
  });
  const latest = workflow.get(reviewId);
  if (
    latest.revision !== revision ||
    latest.state !== "rendered" ||
    latest.render?.hash !== before.render.hash
  )
    throw Error("Render changed during queue registration");
  const ledger = createPublishingLedger(config.publishingDb);
  try {
    const accountId = resolvePublishingAccountId(environment);
    const existing = ledger
      .getQueue()
      .find(
        (item) =>
          item.artifactRelativePath === artifactRelativePath &&
          item.artifactHash === artifactHash,
      );
    if (existing && existing.accountId !== accountId)
      throw Error("Artifact is already assigned to a different account");
    const item = await enqueueCompletedArtifact({
      ledger,
      projectRoot,
      artifactRoot: config.artifactRoot,
      artifactRelativePath,
      artifactHash,
      accountId,
      title: script.title,
      treatmentId: "animated-explainer",
      treatmentVersion: "1",
    });
    if (item.accountId !== accountId)
      throw Error("Artifact is already assigned to a different account");
    return { id: item.id, state: item.state };
  } finally {
    ledger.close();
  }
}
