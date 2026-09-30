import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export const createPipelineLogger = ({ logPath, now = () => new Date().toISOString() }) => {
  if (typeof logPath !== "string" || logPath.trim() === "") {
    throw new Error("logPath is required");
  }
  return Object.freeze({
    event: async (input) => {
      const normalized = normalizeEvent(input ?? {}, now());
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      await appendFile(logPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
      return normalized;
    },
  });
};

export const readPipelineEvents = async (logPath, { limit = 100 } = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  let content;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(-limit)
    .reverse();
};
