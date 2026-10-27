import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:fs";
import process from "node:process";
import { parseYouTubeVideoUrl } from "../../scripts/youtube-url-core.mjs";
import {
  validateCliResult,
  validateStoredResult,
} from "./result-validation.mjs";
import {
  createJobDiagnostics,
  resolveDiagnosticsRoot,
} from "./job-diagnostics.mjs";
import {
  persistFinalResult,
  recoverPendingFinalizations,
} from "./mcp-finalization.mjs";
import { requireEventPrincipal } from "./mcp-events.mjs";
import { resolveStorageConfig } from "../../scripts/storage-config.mjs";

export function createLocalRunner({
  jobStore,
  projectRoot,
  workerPath,
  diagnosticsRoot = process.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
  spawnProcess = spawn,
  environment = process.env,
  eventsEnabled = false,
  jobStorePath,
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
}) {
  const recoveryRoot = resolveDiagnosticsRoot({ projectRoot, diagnosticsRoot });
  const validateResult = (result) =>
    validateStoredResult(result, projectRoot, {
      artifactRoot: resolveStorageConfig(environment).artifactRoot,
    });
  const checkOwner = (job, principal) => {
    if (
      eventsEnabled &&
      (!job || job.ownerId !== requireEventPrincipal(principal))
    )
      throw new Error("Audiogram job was not found.");
  };
  const health = (jobId, principal) => {
    if (!eventsEnabled) return {};
    try {
      return {
        notificationHealth: jobStore.getNotificationHealth(jobId, {
          principal,
        }),
      };
    } catch {
      // Ownership was checked before this diagnostic-only query. Never turn
      // a notification-store failure into an artifact or processing failure.
      return {
        notificationHealth: { capture: "unknown", delivery: "degraded" },
      };
    }
  };
  const recordFailure = async (jobId, stage, code, message) => {
    const job = jobStore.getJob(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return;
    return persistFinalResult({
      store: jobStore,
      jobId,
      recoveryRoot,
      onHealth: (health) => process.stderr.write(`${JSON.stringify(health)}\n`),
      result: {
        status: "failed",
        title: null,
        artifacts: [],
        failures: [{ stage, code, message }],
        error: message,
      },
    });
  };
  const launchWorker = async (job) => {
    const diagnostics = createJobDiagnostics({
      projectRoot,
      diagnosticsRoot,
      jobId: job.jobId,
    });
    let stdoutFd;
    let stderrFd;
    let diagnosticsIncomplete = false;
    try {
      await diagnostics.ready;
    } catch {
      diagnosticsIncomplete = true;
    }
    if (!diagnosticsIncomplete) {
      try {
        stdoutFd = openSync(
          diagnostics.files.workerStdout,
          constants.O_WRONLY | constants.O_APPEND,
        );
        stderrFd = openSync(
          diagnostics.files.workerStderr,
          constants.O_WRONLY | constants.O_APPEND,
        );
      } catch {
        diagnosticsIncomplete = true;
      }
    }
    if (diagnosticsIncomplete) {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      stdoutFd = stderrFd = undefined;
    }
    try {
      const childEnvironment = {
        ...environment,
        AUDIOGRAM_PROJECT_ROOT: projectRoot,
        AUDIOGRAM_DIAGNOSTICS_ROOT: diagnostics.root,
        ...(diagnosticsIncomplete
          ? { AUDIOGRAM_DIAGNOSTICS_INCOMPLETE: "1" }
          : {}),
      };
      delete childEnvironment.AUDIOGRAM_EVENT_SECRET_KEY;
      if (jobStorePath) childEnvironment.AUDIOGRAM_JOB_STORE = jobStorePath;
      if (eventsEnabled) childEnvironment.AUDIOGRAM_EVENT_CAPTURE_ENABLED = "1";
      const child = spawnProcess(
        process.execPath,
        [
          workerPath,
          "--job-id",
          job.jobId,
          "--url",
          job.sourceUrl,
          "--template",
          job.selection.templateId,
          "--template-version",
          job.selection.templateVersion,
          "--variation",
          job.selection.variationId,
        ],
        {
          cwd: projectRoot,
          detached: true,
          shell: false,
          stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
          env: childEnvironment,
        },
      );
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      stdoutFd = stderrFd = undefined;
      child.once?.("error", () => {
        void recordFailure(
          job.jobId,
          "worker",
          "WORKER_START_FAILED",
          "Worker could not be started.",
        ).catch(() => {});
      });
      if (!child.pid) throw new Error("Worker could not be started.");
      jobStore.markRunning(job.jobId, child.pid);
      child.unref();
    } catch {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      await recordFailure(
        job.jobId,
        "worker",
        "WORKER_START_FAILED",
        "Worker could not be started.",
      );
    }
  };
  return {
    async start({ url, videoId, templateSelection, principal }) {
      const resolved = resolveTemplateSelection(templateSelection);
      const { job, created } = jobStore.createOrGetJob({
        videoId,
        sourceUrl: url,
        selection: resolved.selection,
        renderKey: resolved.renderKey,
        ...(eventsEnabled ? { ownerId: requireEventPrincipal(principal) } : {}),
      });
      if (created) {
        await launchWorker(job);
        return this.getStatus(job.jobId, { principal });
      }
      return {
        jobId: job.jobId,
        status: job.status,
        artifacts: [],
        ...health(job.jobId, principal),
        ...(job.error ? { error: job.error } : {}),
      };
    },
    async getStatus(jobId, { principal } = {}) {
      let job = jobStore.getJob(jobId);
      if (!job) return null;
      checkOwner(job, principal);
      const workerStopped =
        job.status === "running" && job.pid && !isProcessAlive(job.pid);
      if (job.status === "queued" || workerStopped) {
        const recovered = await recoverPendingFinalizations({
          store: jobStore,
          recoveryRoot,
          jobId,
          validateResult,
        });
        if (recovered.pending || recovered.rejected)
          throw Object.assign(
            new Error("Job result is waiting for safe finalization."),
            { code: "FINALIZATION_PENDING" },
          );
        job = jobStore.getJob(jobId);
        checkOwner(job, principal);
      }
      if (job.status === "running" && workerStopped) {
        const message = "Worker stopped before recording a terminal result.";
        await recordFailure(jobId, "worker", "WORKER_PROCESS_FAILED", message);
        return this.getStatus(jobId, { principal });
      }
      if (job.status === "complete" || job.status === "partial") {
        try {
          await validateResult(job.result);
          const result = await validateCliResult(
            {
              contractVersion: 1,
              status: job.status,
              source: { title: job.result.title },
              artifactPaths: job.result.artifacts,
              failures: job.result.failures,
              diagnosticsIncomplete: job.result.diagnosticsIncomplete,
            },
            projectRoot,
            { artifactRoot: resolveStorageConfig(environment).artifactRoot },
          );
          return {
            jobId,
            ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}),
            ...result,
            ...(job.finalizedAt
              ? { notificationHealth: { capture: job.captureHealth } }
              : {}),
            ...health(jobId, principal),
          };
        } catch {
          const message = "A completed artifact could not be verified.";
          throw Object.assign(new Error(message), {
            code: "ARTIFACT_UNAVAILABLE",
          });
        }
      }
      const safeFailure = job.result?.failures?.[0]?.message;
      const statusError =
        job.status === "no_clips"
          ? (job.result?.error ?? "No clips were selected from this video.")
          : (safeFailure ??
            (job.result ? "Audiogram processing failed." : job.error));
      return {
        jobId,
        status: job.status,
        artifacts: [],
        ...(job.finalizedAt
          ? { notificationHealth: { capture: job.captureHealth } }
          : {}),
        ...health(jobId, principal),
        ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}),
        ...(job.result?.failures ? { failures: job.result.failures } : {}),
        ...(job.result?.diagnosticsIncomplete
          ? { diagnosticsIncomplete: true }
          : {}),
        ...(job.error || job.status === "no_clips"
          ? { error: statusError }
          : {}),
      };
    },
    async retry({ jobId, principal }) {
      checkOwner(jobStore.getJob(jobId), principal);
      const { job } = jobStore.createRetryJob({
        priorJobId: jobId,
        ...(eventsEnabled ? { ownerId: requireEventPrincipal(principal) } : {}),
      });
      await launchWorker(job);
      return this.getStatus(job.jobId, { principal });
    },
  };
}

export function parseAndValidateUrl(url) {
  return parseYouTubeVideoUrl(url);
}
