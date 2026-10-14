import { openArtifact, hashHandle, sameStat } from "./publishing-artifact.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Caller owns one exclusive lock for the complete invocation, including recovery.
export const runPublishingOnce = async ({
  ledger,
  execution,
  lock,
  client,
  config,
  itemId,
  now = () => new Date().toISOString(),
  sleep = delay,
}) => {
  if (typeof itemId !== "string" || !itemId)
    throw new Error("Explicit item required");
  await lock.assertOwned();
  let item = ledger.getPublishingItem(itemId);
  const result = (status, extra = {}) => ({ status, itemId, ...extra });
  if (!item || item.accountId !== config.accountId) return result("ineligible");
  if (
    ["published", "failed", "unknown", "queued", "rejected"].includes(
      item.state,
    )
  )
    return result(item.state, {
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    });
  if (
    item.approvalDecision !== "approved" ||
    item.approvedCaption !== item.caption ||
    item.approvedArtifactHash !== item.artifactHash ||
    !item.approvedAt ||
    !item.scheduledAt ||
    Date.parse(item.scheduledAt) > Date.parse(now())
  )
    return result("ineligible");
  await client.verifyAccount({
    pageId: config.pageId,
    accountId: config.accountId,
    username: config.username,
  });
  await lock.assertOwned();
  if (item.state === "approved") {
    item = ledger.claimDueApprovedItem(now(), {
      accountId: config.accountId,
      itemId,
    });
    if (!item) return result("ineligible");
  }
  let attempt = execution.getAttempt(itemId);
  if (!attempt || (attempt.phase === "failed" && attempt.safeToRetry)) {
    execution.beginAttempt(itemId);
    attempt = execution.getAttempt(itemId);
  }
  const checkpoint = (phase, patch) => {
    attempt = execution.checkpoint(attempt.id, phase, patch);
  };
  const unknown = (errorCode) => {
    checkpoint("unknown", { errorCode });
    return result("unknown", { containerId: attempt.containerId, errorCode });
  };
  const fail = (errorCode, safeToRetry = true) => {
    checkpoint("failed", { errorCode, safeToRetry });
    return result("failed", { errorCode });
  };
  const recordError = (operation, error) => execution.recordDiagnostic(attempt.id, {
    operation, errorCode: error?.code, httpStatus: error?.httpStatus,
    providerCode: error?.providerCode, providerSubcode: error?.providerSubcode,
  });
  if (attempt.phase === "create_requested")
    return unknown("CREATE_OUTCOME_UNCERTAIN");
  if (attempt.phase === "publish_requested") {
    // A GET can aid the operator but cannot justify replaying a publication.
    try {
      await client.getContainerStatus(attempt.containerId);
    } catch {
      /* preserve ambiguity */
    }
    return unknown("PUBLISH_OUTCOME_UNCERTAIN");
  }
  if (["published", "failed", "unknown"].includes(attempt.phase))
    return result(attempt.phase);
  let artifact;
  try {
    artifact = await openArtifact(
      config.projectRoot,
      item,
      config.artifactRoot,
    );
  } catch {
    return fail("ARTIFACT_INVALID");
  }
  try {
    if (attempt.phase === "claimed") {
      await lock.assertOwned();
      checkpoint("create_requested");
      let container;
      try {
        container = await client.createContainer({
          accountId: config.accountId,
          caption: item.approvedCaption,
        });
      } catch (error) {
        recordError("create_container", error);
        return error.ambiguous === false
          ? fail("CREATE_REJECTED")
          : unknown("CREATE_OUTCOME_UNCERTAIN");
      }
      checkpoint("container_created", {
        containerId: container.id,
        uploadUri: container.uri,
      });
    }
    if (attempt.phase === "container_created") {
      await lock.assertOwned();
      checkpoint("upload_requested");
      try {
        await client.uploadVideo({
          uri: attempt.uploadUri,
          fileHandle: artifact.handle,
          size: Number(artifact.info.size),
        });
      } catch (error) {
        recordError("upload_video", error);
        if (error.ambiguous === false) return fail("UPLOAD_REJECTED");
        // Intent is durable. Next run reads status; it must not resend bytes.
        return result("pending", {
          containerId: attempt.containerId,
          errorCode: "UPLOAD_OUTCOME_UNCERTAIN",
        });
      }
      checkpoint("processing");
    }
    // Recheck bytes on the same descriptor before allowing a publish request.
    try {
      const after = await hashHandle(
        artifact.handle,
        item.approvedArtifactHash,
      );
      if (!sameStat(artifact.info, after))
        throw new Error("Artifact changed during upload");
    } catch {
      return fail("ARTIFACT_CHANGED");
    }
    for (let poll = 0; poll < 5; poll++) {
      await lock.assertOwned();
      let detail;
      try {
        detail = await client.getContainerStatus(attempt.containerId);
      } catch (error) {
        recordError("container_status", error);
        return result("pending", {
          containerId: attempt.containerId,
          errorCode: "STATUS_UNAVAILABLE",
        });
      }
      execution.recordDiagnostic(attempt.id, { ...detail, operation: "container_status" });
      const status = detail.statusCode;
      if (status === "PUBLISHED") return unknown("PUBLISHED_ID_UNCONFIRMED");
      // recordDiagnostic atomically persists the error and non-retryable failure.
      if (detail.uploadPhase === "error") return result("failed", {errorCode:"UPLOAD_PHASE_ERROR"});
      if (detail.processingPhase === "error") return result("failed", {errorCode:"PROCESSING_PHASE_ERROR"});
      if (status === "ERROR" || status === "EXPIRED")
        return fail(`CONTAINER_${status}`);
      if (status === "FINISHED") {
        if (detail.uploadPhase !== "complete" || detail.processingPhase !== "complete") {
          return result("pending", { containerId: attempt.containerId, errorCode: "READINESS_DETAILS_INCOMPLETE" });
        }
        if (attempt.phase === "upload_requested") checkpoint("processing");
        await lock.assertOwned();
        checkpoint("publish_requested");
        let published;
        try {
          published = await client.publishContainer({
            accountId: config.accountId,
            containerId: attempt.containerId,
          });
        } catch (error) {
          recordError("publish_container", error);
          return unknown("PUBLISH_OUTCOME_UNCERTAIN");
        }
        // If this commit fails, durable intent still forbids duplicate publication.
        // Return the confirmed ID for operator reconciliation without claiming local success.
        try {
          checkpoint("published", { mediaId: published.id });
        } catch (error) {
          error.confirmedMediaId = published.id;
          throw error;
        }
        return result("published", {
          containerId: attempt.containerId,
          mediaId: published.id,
        });
      }
      if (status !== "IN_PROGRESS")
        return result("pending", { errorCode: "STATUS_UNRECOGNIZED" });
      if (poll < 4) await sleep(60000);
    }
    return result("pending", { containerId: attempt.containerId });
  } finally {
    await artifact.handle.close();
  }
};
