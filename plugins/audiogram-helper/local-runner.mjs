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

export function createLocalRunner({
  jobStore,
  projectRoot,
  workerPath,
  diagnosticsRoot = process.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
  spawnProcess = spawn,
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
        ...process.env,
        AUDIOGRAM_PROJECT_ROOT: projectRoot,
        AUDIOGRAM_DIAGNOSTICS_ROOT: diagnostics.root,
        ...(diagnosticsIncomplete
          ? { AUDIOGRAM_DIAGNOSTICS_INCOMPLETE: "1" }
          : {}),
      };
      delete childEnvironment.AUDIOGRAM_EVENT_SECRET_KEY;
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
    async start({ url, videoId, templateSelection }) {
      const resolved = resolveTemplateSelection(templateSelection);
      const { job, created } = jobStore.createOrGetJob({
        videoId,
        sourceUrl: url,
        selection: resolved.selection,
        renderKey: resolved.renderKey,
      });
      if (created) {
        await launchWorker(job);
        return this.getStatus(job.jobId);
      }
      return {
        jobId: job.jobId,
        status: job.status,
        artifacts: [],
        ...(job.error ? { error: job.error } : {}),
      };
    },
    async getStatus(jobId) {
      let job = jobStore.getJob(jobId);
      if (!job) return null;
      const workerStopped =
        job.status === "running" && job.pid && !isProcessAlive(job.pid);
      if (job.status === "queued" || workerStopped) {
        const recovered = await recoverPendingFinalizations({
          store: jobStore,
          recoveryRoot,
          jobId,
          validateResult: (result) => validateStoredResult(result, projectRoot),
        });
        if (recovered.pending || recovered.rejected)
          throw Object.assign(
            new Error("Job result is waiting for safe finalization."),
            { code: "FINALIZATION_PENDING" },
          );
        job = jobStore.getJob(jobId);
      }
      if (job.status === "running" && workerStopped) {
        const message = "Worker stopped before recording a terminal result.";
        await recordFailure(jobId, "worker", "WORKER_PROCESS_FAILED", message);
        return this.getStatus(jobId);
      }
      if (job.status === "complete" || job.status === "partial") {
        try {
          await validateStoredResult(job.result, projectRoot);
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
          );
          return {
            jobId,
            ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}),
            ...result,
            ...(job.finalizedAt
              ? { notificationHealth: { capture: job.captureHealth } }
              : {}),
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
    async retry({ jobId }) {
      const { job } = jobStore.createRetryJob({ priorJobId: jobId });
      await launchWorker(job);
      return this.getStatus(job.jobId);
    },
  };
}

export function parseAndValidateUrl(url) {
  return parseYouTubeVideoUrl(url);
}
