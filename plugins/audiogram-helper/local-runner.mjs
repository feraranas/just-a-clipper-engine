import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { constants } from 'node:fs';
import process from 'node:process';
import { parseYouTubeVideoUrl } from '../../scripts/youtube-url-core.mjs';
import { validateCliResult } from './result-validation.mjs';
import { createJobDiagnostics } from './job-diagnostics.mjs';

export function createLocalRunner({ jobStore, projectRoot, workerPath, diagnosticsRoot = process.env.AUDIOGRAM_DIAGNOSTICS_ROOT, spawnProcess = spawn, isProcessAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } }) {
  const recordFailure = (jobId, stage, code, message) => jobStore.setResult(jobId, {
    status: 'failed',
    title: null,
    artifacts: [],
    failures: [{ stage, code, message }],
    error: message,
  });
  const launchWorker = async (job) => {
    const diagnostics = createJobDiagnostics({ projectRoot, diagnosticsRoot, jobId: job.jobId });
    let stdoutFd;
    let stderrFd;
    try {
      await diagnostics.ready;
      stdoutFd = openSync(diagnostics.files.workerStdout, constants.O_WRONLY | constants.O_APPEND);
      stderrFd = openSync(diagnostics.files.workerStderr, constants.O_WRONLY | constants.O_APPEND);
      const child = spawnProcess(process.execPath, [workerPath, '--job-id', job.jobId, '--url', job.sourceUrl], {
        cwd: projectRoot,
        detached: true,
        shell: false,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: { ...process.env, AUDIOGRAM_PROJECT_ROOT: projectRoot, AUDIOGRAM_DIAGNOSTICS_ROOT: diagnostics.root },
      });
      closeSync(stdoutFd);
      closeSync(stderrFd);
      stdoutFd = stderrFd = undefined;
      if (!child.pid) throw new Error('Worker could not be started.');
      child.once?.('error', () => recordFailure(job.jobId, 'worker', 'WORKER_START_FAILED', 'Worker could not be started.'));
      jobStore.markRunning(job.jobId, child.pid);
      child.unref();
    } catch {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      recordFailure(job.jobId, 'worker', 'WORKER_START_FAILED', 'Worker could not be started.');
    }
  };
  return {
    async start({ url, videoId }) {
      const { job, created } = jobStore.createOrGetJob({ videoId, sourceUrl: url });
      if (created) {
        await launchWorker(job);
        return this.getStatus(job.jobId);
      }
      return { jobId: job.jobId, status: job.status, artifacts: [], ...(job.error ? { error: job.error } : {}) };
    },
    async getStatus(jobId) {
      const job = jobStore.getJob(jobId);
      if (!job) return null;
      if (job.status === 'running' && job.pid && !isProcessAlive(job.pid)) {
        const message = 'Worker stopped before recording a terminal result.';
        recordFailure(jobId, 'worker', 'WORKER_PROCESS_FAILED', message);
        return { jobId, status: 'failed', artifacts: [], failures: [{ stage: 'worker', code: 'WORKER_PROCESS_FAILED', message }], error: message };
      }
      if (job.status === 'complete' || job.status === 'partial') {
        try {
          const result = await validateCliResult({
            contractVersion: 1,
            status: job.status,
            source: { title: job.result.title },
            artifactPaths: job.result.artifacts,
            failures: job.result.failures,
            diagnosticsIncomplete: job.result.diagnosticsIncomplete,
          }, projectRoot);
          return { jobId, ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}), ...result };
        } catch {
          const message = 'A completed artifact could not be verified.';
          recordFailure(jobId, 'artifact_verification', 'ARTIFACT_VERIFICATION_FAILED', message);
          return { jobId, status: 'failed', artifacts: [], failures: [{ stage: 'artifact_verification', code: 'ARTIFACT_VERIFICATION_FAILED', message }], error: message };
        }
      }
      const safeFailure = job.result?.failures?.[0]?.message;
      return { jobId, status: job.status, artifacts: [], ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}), ...(job.result?.failures ? { failures: job.result.failures } : {}), ...(job.result?.diagnosticsIncomplete ? { diagnosticsIncomplete: true } : {}), ...(job.error ? { error: safeFailure ?? (job.result ? 'Audiogram processing failed.' : job.error) } : {}) };
    },
    async retry({ jobId }) {
      const { job } = jobStore.createRetryJob({ priorJobId: jobId });
      await launchWorker(job);
      return this.getStatus(job.jobId);
    },
  };
}

export function parseAndValidateUrl(url) { return parseYouTubeVideoUrl(url); }
