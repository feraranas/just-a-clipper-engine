import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";

const maximumTailBytes = 8 * 1024 * 1024;
const minimumTailBytes = 64 * 1024;
const bytesPerRequestedEvent = 16 * 1024;

const EVENT_FIELDS = [
  "runId",
  "stage",
  "status",
  "videoId",
  "packageVersion",
  "treatmentId",
  "itemId",
  "durationMs",
  "errorCode",
  "errorMessage",
];

const normalizeEvent = (event, timestamp) => Object.fromEntries([
  ["timestamp", timestamp],
  ...EVENT_FIELDS
    .filter((field) => event[field] !== undefined)
    .map((field) => [field, event[field]]),
]);

export const createPipelineLogger = ({
  logPath,
  now = () => new Date().toISOString(),
  onError,
}) => {
  if (typeof logPath !== "string" || logPath.trim() === "") {
    throw new Error("logPath is required");
  }
  return Object.freeze({
    event: async (input) => {
      const normalized = normalizeEvent(input ?? {}, now());
      try {
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // Diagnostic callbacks are also best effort.
        }
      }
      return normalized;
    },
  });
};

export const readPipelineEvents = async (logPath, { limit = 100 } = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  let file;
  try {
    file = await open(logPath, "r");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const requestedTailBytes = Math.max(
      minimumTailBytes,
      limit * bytesPerRequestedEvent,
    );
    const tailBytes = Math.min(size, maximumTailBytes, requestedTailBytes);
    const offset = size - tailBytes;
    const buffer = Buffer.alloc(tailBytes);
    if (tailBytes > 0) await file.read(buffer, 0, tailBytes, offset);
    let content = buffer.toString("utf8");

    if (offset > 0) {
      const precedingByte = Buffer.alloc(1);
      await file.read(precedingByte, 0, 1, offset - 1);
      if (precedingByte[0] !== 0x0a) {
        const firstNewline = content.indexOf("\n");
        content = firstNewline === -1 ? "" : content.slice(firstNewline + 1);
      }
    }

    const lines = content.split("\n").filter(Boolean);
    const events = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        events.push(JSON.parse(lines[index]));
      } catch {
        // A damaged JSONL record must not hide valid records in the tail.
      }
      if (events.length === limit) break;
    }
    return events;
  } finally {
    await file.close();
  }
};

const safelyEmit = async (logger, event) => {
  try {
    await logger?.event(event);
  } catch {
    // Activity logging must never control pipeline execution.
  }
};

export const runLoggedStage = async ({
  logger,
  stage,
  runId,
  videoId,
  packageVersion,
  operation,
  hasFailures = () => false,
  failureFields = () => ({}),
}) => {
  const startedAt = Date.now();
  const metadata = { runId, stage, videoId, packageVersion };
  await safelyEmit(logger, { ...metadata, status: "started" });

  try {
    const result = await operation();
    const failed = hasFailures(result);
    await safelyEmit(logger, {
      ...metadata,
      ...(failed ? failureFields(result) : {}),
      status: failed ? "failed" : "completed",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    let errorMessage = sanitizeErrorDiagnostic(error);
    let errorCode;
    try {
      const diagnostic = JSON.parse(errorMessage);
      if (diagnostic && typeof diagnostic === "object") {
        errorCode = diagnostic.code;
        errorMessage = diagnostic.code ?? errorMessage;
      }
    } catch {
      // The sanitized diagnostic is already suitable for the allowlisted event.
    }
    await safelyEmit(logger, {
      ...metadata,
      status: "failed",
      durationMs: Date.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
      errorMessage,
    });
    throw error;
  }
};
