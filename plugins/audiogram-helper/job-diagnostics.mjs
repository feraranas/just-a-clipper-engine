import { mkdir, open, chmod, readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  createPipelineLogger,
  readPipelineEvents,
} from "../../scripts/pipeline-logger.mjs";

export const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const filenames = Object.freeze({
  events: "pipeline.jsonl",
  workerStdout: "worker.stdout.log",
  workerStderr: "worker.stderr.log",
  pipelineStdout: "pipeline.stdout.log",
  pipelineStderr: "pipeline.stderr.log",
});
const defaultMaxFileBytes = (() => {
  const value = Number(process.env.AUDIOGRAM_DIAGNOSTICS_MAX_FILE_BYTES);
  return Number.isInteger(value) && value >= 1024 && value <= 50 * 1024 * 1024
    ? value
    : 2 * 1024 * 1024;
})();

export function validateJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId))
    throw new Error("jobId must be a valid UUID");
  return jobId;
}

export function resolveDiagnosticsRoot({
  projectRoot = process.cwd(),
  diagnosticsRoot,
} = {}) {
  return resolve(
    diagnosticsRoot ?? join(projectRoot, ".local", "audiogram-helper", "runs"),
  );
}

export function createJobDiagnostics({
  projectRoot = process.cwd(),
  diagnosticsRoot,
  jobId,
  now,
  onError,
  retentionDays = Number(
    process.env.AUDIOGRAM_DIAGNOSTICS_RETENTION_DAYS ?? 30,
  ),
  currentTime = Date.now(),
  maxFileBytes = defaultMaxFileBytes,
} = {}) {
  validateJobId(jobId);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  )
    throw new Error("retentionDays must be an integer between 1 and 3650");
  if (
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes < 1024 ||
    maxFileBytes > 50 * 1024 * 1024
  )
    throw new Error(
      "maxFileBytes must be an integer between 1024 and 52428800",
    );
  const root = resolveDiagnosticsRoot({ projectRoot, diagnosticsRoot });
  const directory = join(root, jobId);
  const files = Object.freeze(
    Object.fromEntries(
      Object.entries(filenames).map(([key, name]) => [
        key,
        join(directory, name),
      ]),
    ),
  );
  let diagnosticsIncomplete = false;
  const logger = createPipelineLogger({
    logPath: files.events,
    now,
    maxFileBytes,
    onError: async (error) => {
      diagnosticsIncomplete = true;
      await onError?.(error);
    },
  });

  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      /* root may be new or inaccessible */
    }
    const cutoff = currentTime - retentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            JOB_ID_PATTERN.test(entry.name) &&
            entry.name !== jobId,
        )
        .map(async (entry) => {
          const oldPath = join(root, entry.name);
          try {
            if ((await stat(oldPath)).mtimeMs < cutoff)
              await rm(oldPath, { recursive: true, force: true });
          } catch {
            /* retention cleanup is best effort */
          }
        }),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    for (const path of Object.values(files)) {
      const handle = await open(path, "a", 0o600);
      await handle.chmod(0o600);
      await handle.close();
    }
  })().catch(async (error) => {
    diagnosticsIncomplete = true;
    try {
      await onError?.(error);
    } catch {
      /* diagnostics setup is best effort */
    }
  });
  const event = async (input) => {
    try {
      await ready;
      return await logger.event({ ...input, jobId, runId: jobId });
    } catch (error) {
      diagnosticsIncomplete = true;
      try {
        await onError?.(error);
      } catch {
        /* diagnostics are best effort */
      }
      return undefined;
    }
  };
  const scopedLogger = Object.freeze({ event });

  return Object.freeze({
    jobId,
    root,
    directory,
    files,
    logger: scopedLogger,
    ready,
    readEvents: async ({ limit = 100 } = {}) => {
      validateJobId(jobId);
      await ready;
      return (await readPipelineEvents(files.events, { limit })).reverse();
    },
    get diagnosticsIncomplete() {
      return diagnosticsIncomplete;
    },
  });
}

export async function readJobDiagnostics({
  projectRoot = process.cwd(),
  diagnosticsRoot,
  jobId,
  limit = 100,
} = {}) {
  validateJobId(jobId);
  const directory = join(
    resolveDiagnosticsRoot({ projectRoot, diagnosticsRoot }),
    jobId,
  );
  const eventsPath = join(directory, filenames.events);
  const events = (await readPipelineEvents(eventsPath, { limit }))
    .filter((event) => event.jobId === jobId && event.runId === jobId)
    .reverse();
  return { found: events.length > 0, events };
}
