import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeDiagnosticError } from "./error-diagnostics.mjs";

const maximumTailBytes = 8 * 1024 * 1024;
const minimumTailBytes = 64 * 1024;
const bytesPerRequestedEvent = 16 * 1024;

const identifiers = [
  "runId",
  "jobId",
  "stage",
  "status",
  "videoId",
  "packageVersion",
  "treatmentId",
  "itemId",
  "clipPackageId",
  "errorCode",
];
const measurements = ["durationMs", "count"];

// Normalize reads and writes; never serialize arbitrary payloads or errors.
export const normalizePipelineEvent = (input, timestamp) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = {};
  if (typeof timestamp === "string") event.timestamp = timestamp.slice(0, 64);
  for (const key of identifiers) {
    const value = input[key];
    if (
      (typeof value === "string" && /^[a-zA-Z0-9_.:@/-]{1,128}$/.test(value)) ||
      (Number.isSafeInteger(value) && value >= 0)
    )
      event[key] = value;
  }
  for (const key of measurements) {
    if (Number.isFinite(input[key]) && input[key] >= 0) event[key] = input[key];
  }
  return event.stage && event.status ? event : null;
};

export const createPipelineLogger = ({
  logPath,
  now = () => new Date().toISOString(),
  onError,
  maxFileBytes = Number.POSITIVE_INFINITY,
} = {}) => {
  if (typeof logPath !== "string" || !logPath.trim())
    throw new Error("logPath is required");
  let writeChain = Promise.resolve();
  return Object.freeze({
    event: (input) => {
      const write = async () => {
      try {
        const event = normalizePipelineEvent(input, now());
        if (!event) return;
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        const record = `\n${JSON.stringify(event)}\n`;
        let currentBytes = 0;
        try { currentBytes = (await stat(logPath)).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (currentBytes + Buffer.byteLength(record) > maxFileBytes)
          throw Object.assign(new Error("Structured diagnostic file reached its size limit."), { code: "DIAGNOSTICS_SIZE_LIMIT" });
        // Isolate an earlier interrupted append from the new record.
        await appendFile(logPath, record, {
          mode: 0o600,
        });
        return event;
      } catch (error) {
        try {
          await onError?.(error);
        } catch {
          /* Observability is best effort. */
        }
      }
      };
      writeChain = writeChain.then(write, write);
      return writeChain;
    },
  });
};

export const readPipelineEvents = async (logPath, { limit = 100 } = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("limit must be an integer between 1 and 1000");
  let file;
  try {
    file = await open(logPath, "r");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(
      size,
      maximumTailBytes,
      Math.max(minimumTailBytes, limit * bytesPerRequestedEvent),
    );
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(
        buffer,
        read,
        length - read,
        offset + read,
      );
      if (!bytesRead) break;
      read += bytesRead;
    }
    let content = buffer.subarray(0, read).toString("utf8");
    if (offset > 0) {
      const preceding = Buffer.alloc(1);
      await file.read(preceding, 0, 1, offset - 1);
      if (preceding[0] !== 10)
        content = content.includes("\n")
          ? content.slice(content.indexOf("\n") + 1)
          : "";
    }
    const lines = content.split("\n");
    const events = [];
    for (
      let index = lines.length - 1;
      index >= 0 && events.length < limit;
      index--
    ) {
      try {
        const parsed = JSON.parse(lines[index]);
        const event = normalizePipelineEvent(parsed, parsed?.timestamp);
        if (event) events.push(event);
      } catch {
        /* Preserve valid records around damaged or incomplete lines. */
      }
    }
    return events;
  } finally {
    await file.close();
  }
};

export const emitPipelineEvent = async (onEvent, event) => {
  try {
    await onEvent?.(event);
  } catch {
    /* Never change the operation outcome. */
  }
};

export const runLoggedStage = async ({
  logger,
  operation,
  hasFailures = () => false,
  failureStatus = "failed",
  ...metadata
}) => {
  const startedAt = Date.now();
  await emitPipelineEvent(logger?.event, { ...metadata, status: "started" });
  try {
    const result = await operation();
    await emitPipelineEvent(logger?.event, {
      ...metadata,
      status: hasFailures(result) ? failureStatus : "completed",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await emitPipelineEvent(logger?.event, {
      ...metadata,
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorCode:
        error instanceof SafeDiagnosticError ? error.code : "operation_failed",
    });
    throw error;
  }
};
