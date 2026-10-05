import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { spawn } from "node:child_process";
import process from "node:process";
import { parseYouTubeVideoUrl } from "../../scripts/youtube-url-core.mjs";
import { validateCliResult } from "./result-validation.mjs";

export function createLocalRunner({
  jobStore,
  projectRoot,
  workerPath,
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
        try {
          const child = spawnProcess(
            process.execPath,
            [
              workerPath,
              "--job-id",
              job.jobId,
              "--url",
              url,
              "--template",
              resolved.selection.templateId,
              "--template-version",
              resolved.selection.templateVersion,
              "--variation",
              resolved.selection.variationId,
            ],
            { cwd: projectRoot, detached: true, shell: false, stdio: "ignore" },
          );
          if (!child.pid) throw new Error("Worker could not be started.");
          child.once?.("error", () =>
            jobStore.setFailed(job.jobId, "Worker could not be started."),
          );
          jobStore.markRunning(job.jobId, child.pid);
          child.unref();
        } catch {
          jobStore.setFailed(job.jobId, "Worker could not be started.");
          throw new Error("Worker could not be started.");
        }
      }
      return created
        ? await this.getStatus(job.jobId)
        : {
            jobId: job.jobId,
            status: job.status,
            artifacts: [],
            ...(job.error ? { error: job.error } : {}),
          };
    },
    async getStatus(jobId) {
      const job = jobStore.getJob(jobId);
      if (!job) return null;
      if (job.status === "running" && job.pid && !isProcessAlive(job.pid)) {
        jobStore.setFailed(
          jobId,
          "Worker stopped before recording a terminal result.",
        );
        return {
          jobId,
          status: "failed",
          artifacts: [],
          error: "Worker stopped before recording a terminal result.",
        };
      }
      if (job.status === "complete") {
        try {
          const result = await validateCliResult(
            {
              contractVersion: 1,
              status: "complete",
              source: { title: job.result.title },
              artifactPaths: job.result.artifacts,
            },
            projectRoot,
          );
          return { jobId, ...result };
        } catch {
          jobStore.setFailed(
            jobId,
            "A completed artifact could not be verified.",
          );
          return {
            jobId,
            status: "failed",
            artifacts: [],
            error: "A completed artifact could not be verified.",
          };
        }
      }
      return {
        jobId,
        status: job.status,
        artifacts: [],
        ...(job.error ? { error: job.error } : {}),
      };
    },
  };
}

export function parseAndValidateUrl(url) {
  return parseYouTubeVideoUrl(url);
}
