import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const absolute = (value, name) => {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value))
    throw new Error(`${name} must be an absolute path`);
  return resolve(value);
};
export const resolveStorageConfig = (environment = process.env) => {
  const dataRoot = absolute(
    environment.AUDIOGRAM_DATA_ROOT ??
      join(homedir(), "Library", "Application Support", "Audiogram Inbox"),
    "AUDIOGRAM_DATA_ROOT",
  );
  const explicit = environment.INSTAGRAM_PUBLISHING_DB_PATH;
  const alias = environment.PUBLISHING_DB;
  if (
    explicit !== undefined &&
    alias !== undefined &&
    absolute(explicit, "INSTAGRAM_PUBLISHING_DB_PATH") !==
      absolute(alias, "PUBLISHING_DB")
  )
    throw new Error("Conflicting publishing database paths");
  return Object.freeze({
    dataRoot,
    artifactRoot: absolute(
      environment.AUDIOGRAM_ARTIFACT_ROOT ?? dataRoot,
      "AUDIOGRAM_ARTIFACT_ROOT",
    ),
    processingDb: absolute(
      environment.AUDIOGRAM_DB_PATH ?? join(dataRoot, "audiograms.sqlite"),
      "AUDIOGRAM_DB_PATH",
    ),
    publishingDb: absolute(
      explicit ?? alias ?? join(dataRoot, "instagram-publishing.sqlite"),
      "INSTAGRAM_PUBLISHING_DB_PATH",
    ),
    pipelineLog: absolute(
      environment.AUDIOGRAM_PIPELINE_LOG_PATH ??
        join(dataRoot, "pipeline.jsonl"),
      "AUDIOGRAM_PIPELINE_LOG_PATH",
    ),
  });
};
