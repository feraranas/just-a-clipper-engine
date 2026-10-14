import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createPublishingLedger } from "../publishing-ledger.mjs";
import { createPublishingExecution } from "../publishing-execution.mjs";

export const uploadError = {
  statusCode: "IN_PROGRESS",
  uploadPhase: "error",
  processingPhase: "error",
  bytesTransferred: 0,
  sourceFileSize: 0,
  providerCodes: [1363008],
};
export const recoveryFixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "instagram-recovery-"));
  const path = join(root, "queue.sqlite");
  const ledger = createPublishingLedger(path),
    execution = createPublishingExecution(path);
  t.after(async () => {
    execution.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "clip.mp4"), "approved bytes");
  const item = ledger.enqueueArtifact({
    artifactRelativePath: "clip.mp4",
    artifactHash:
      "sha256:" + createHash("sha256").update("approved bytes").digest("hex"),
    title: "Clip",
    caption: "approved",
    accountId: "2",
  });
  ledger.approveItem(item.id, "2026-10-03T00:00:00Z");
  ledger.claimDueApprovedItem("2026-10-13T00:00:00Z");
  const attemptId = execution.beginAttempt(item.id);
  execution.checkpoint(attemptId, "create_requested");
  execution.checkpoint(attemptId, "container_created", {
    containerId: "123",
    uploadUri: "https://rupload.facebook.com/ig-api-upload/v26.0/123",
  });
  execution.checkpoint(attemptId, "upload_requested");
  const config = {
    projectRoot: root,
    accountId: "2",
    pageId: "1",
    username: "theballooninquiries",
  };
  const forbidden = async () => {
    throw new Error("external write forbidden");
  };
  const client = {
    verifyAccount: async () => {},
    getContainerStatus: async () => uploadError,
    createContainer: forbidden,
    uploadVideo: forbidden,
    publishContainer: forbidden,
  };
  return {
    root,
    path,
    itemId: item.id,
    attemptId,
    config,
    client,
    ledger,
    execution,
  };
};
