import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  chmod,
  lstat,
  open,
  link,
  unlink,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { buildJobFinishedEvent } from "./mcp-event-contract.mjs";
import { canonicalJson } from "./mcp-event-store.mjs";
import { validateJobId, JOB_ID_PATTERN } from "./job-diagnostics.mjs";

const filename = "finalization-result.json";
const maximumBytes = 1024 * 1024;
const SidecarSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  sourceUrl: z.string(),
  videoId: z.string(),
  selection: z.record(z.string(), z.unknown()),
  renderKey: z.string(),
  result: z.record(z.string(), z.unknown()),
  capture: z.enum(["complete", "incomplete", "unknown"]),
  createdAt: z.string().datetime({ offset: true }),
});

async function directoryFor(root, jobId, create = false) {
  validateJobId(jobId);
  const base = resolve(root);
  if (create) await mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error("Unsafe recovery directory.");
  const directory = join(base, jobId);
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Unsafe recovery directory.");
  if (create) {
    await chmod(base, 0o700);
    await chmod(directory, 0o700);
  }
  return directory;
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readSidecar(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > maximumBytes)
      throw new Error("Invalid recovery record.");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("Invalid recovery record.");
    return SidecarSchema.parse(
      JSON.parse(buffer.subarray(0, length).toString("utf8")),
    );
  } finally {
    await handle.close();
  }
}
function checkJob(saved, job) {
  if (
    !job ||
    saved.jobId !== job.jobId ||
    saved.runId !== job.runId ||
    saved.sourceUrl !== job.sourceUrl ||
    saved.videoId !== job.videoId ||
    saved.renderKey !== job.renderKey ||
    canonicalJson(saved.selection) !== canonicalJson(job.selection)
  )
    throw new Error("Invalid recovery job identity.");
}
async function writeSidecar(directory, record) {
  const file = join(directory, filename);
  try {
    const prior = await readSidecar(file);
    if (
      canonicalJson({ ...prior, createdAt: null }) !==
      canonicalJson({ ...record, createdAt: null })
    )
      return { durable: false, conflict: true };
    return { durable: true, conflict: false };
  } catch (error) {
    if (error.code !== "ENOENT") return { durable: false, conflict: true };
  }
  const bytes = canonicalJson(record);
  if (Buffer.byteLength(bytes) > maximumBytes)
    throw new Error("Recovery record is too large.");
  const temporary = join(directory, `.finalization-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Atomic no-replace publication: a competing finalizer cannot overwrite a verified result.
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = await readSidecar(file);
      return {
        durable: true,
        conflict:
          canonicalJson({ ...prior, createdAt: null }) !==
          canonicalJson({ ...record, createdAt: null }),
      };
    }
    await syncDirectory(directory);
    return { durable: true, conflict: false };
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}
async function removeSidecar(directory) {
  await unlink(join(directory, filename));
  await syncDirectory(directory);
}

export async function persistFinalResult({
  store,
  jobId,
  result,
  capture = "unknown",
  recoveryRoot,
  clock = () => new Date().toISOString(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  onHealth,
}) {
  const job = store.getJob(jobId);
  if (!job) throw new Error("Audiogram job was not found.");
  if (job.finalizedAt) {
    try {
      return {
        finalized: true,
        eventId: store.finalizeJob(jobId, result, { capture }).event.eventId,
      };
    } catch {
      return { finalized: false, health: "conflict" };
    }
  }
  const createdAt = clock();
  // Validate before writing a recovery record. Callers have already verified artifact bytes.
  buildJobFinishedEvent({
    job,
    result,
    capture,
    eventId: randomUUID(),
    sequence: job.lastEventSequence + 1,
    timestamp: createdAt,
  });
  let directory;
  let durable = false;
  try {
    directory = await directoryFor(recoveryRoot, jobId, true);
    const write = await writeSidecar(directory, {
      version: 1,
      jobId,
      runId: job.runId,
      sourceUrl: job.sourceUrl,
      videoId: job.videoId,
      selection: job.selection,
      renderKey: job.renderKey,
      result,
      capture,
      createdAt,
    });
    if (write.conflict) return { finalized: false, health: "pending" };
    durable = write.durable;
  } catch {
    /* Try atomic SQL even if the recovery mirror is unavailable. */
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { event } = store.finalizeJob(jobId, result, { capture });
      if (durable) await removeSidecar(directory).catch(() => {});
      return { finalized: true, eventId: event.eventId };
    } catch {
      if (attempt < 5) {
        try {
          await sleep(1000 * 2 ** attempt);
        } catch {
          break;
        }
      }
    }
  }
  const health = durable ? "pending" : "unrecoverable";
  try {
    await onHealth?.({
      jobId,
      code: durable ? "FINALIZATION_PENDING" : "FINALIZATION_UNRECOVERABLE",
    });
  } catch {
    /* No raw errors. */
  }
  return { finalized: false, health };
}

export async function recoverPendingFinalizations({
  store,
  recoveryRoot,
  validateResult,
  jobId,
}) {
  if (typeof validateResult !== "function")
    throw new Error("Recovery requires result verification.");
  const summary = { recovered: 0, pending: 0, rejected: 0 };
  let entries;
  try {
    entries = await readdir(recoveryRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return summary;
    throw new Error("Recovery directory is unavailable.");
  }
  if (jobId !== undefined) validateJobId(jobId);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !JOB_ID_PATTERN.test(entry.name) ||
      (jobId !== undefined && entry.name !== jobId)
    )
      continue;
    let directory;
    let saved;
    let verified;
    try {
      directory = await directoryFor(recoveryRoot, entry.name);
      saved = await readSidecar(join(directory, filename));
      const job = store.getJob(entry.name);
      checkJob(saved, job);
      verified = await validateResult(saved.result, job);
      if (canonicalJson(verified) !== canonicalJson(saved.result))
        throw new Error("Recovery validation changed the result.");
    } catch (error) {
      if (saved || error.code !== "ENOENT") summary.rejected++;
      continue;
    }
    try {
      store.finalizeJob(saved.jobId, verified, { capture: saved.capture });
      await removeSidecar(directory).catch(() => {});
      summary.recovered++;
    } catch {
      summary.pending++;
    }
  }
  return summary;
}
