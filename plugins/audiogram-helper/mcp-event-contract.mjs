import { Buffer } from "node:buffer";
import { z } from "zod";
import { JOB_STAGES } from "./job-stages.mjs";

export const EVENT_NAMES = Object.freeze([
  "audiogram.job.progress",
  "audiogram.job.finished",
]);
export const PROGRESS_KINDS = Object.freeze([
  "stage_started",
  "stage_completed",
  "stage_failed",
  "stage_recovery",
  "stage_skipped",
]);
export const TERMINAL_STATUSES = Object.freeze([
  "complete",
  "partial",
  "failed",
  "no_clips",
]);

const internalStages = new Set(["queue", "videos-pending", "video-analysis"]);
const statusKinds = Object.freeze({
  started: "stage_started",
  completed: "stage_completed",
  failed: "stage_failed",
  retrying: "stage_recovery",
  skipped: "stage_skipped",
});
const labels = Object.freeze({
  worker: "Worker",
  intake: "URL intake",
  metadata: "Video metadata",
  setup: "Pipeline setup",
  transcript: "Transcript",
  selection: "Selection",
  jev: "Jev ranking",
  assets: "Media preparation",
  render: "Rendering",
  artifact_verification: "Artifact verification",
});
const suffixes = Object.freeze({
  stage_started: "started.",
  stage_completed: "completed.",
  stage_failed: "failed.",
  stage_recovery: "is recovering within this job.",
  stage_skipped: "was skipped.",
});
const stageCodes = Object.freeze({
  worker: ["WORKER_FAILED", "CLI_CONTRACT_INVALID", "WORKER_EXITED"],
  intake: ["INTAKE_FAILED", "INVALID_URL"],
  metadata: ["METADATA_FAILED"],
  setup: ["PIPELINE_SETUP_FAILED"],
  transcript: ["TRANSCRIPT_FAILED"],
  selection: [
    "SELECTION_FAILED",
    "SELECTION_INVALID_CUE",
    "SELECTION_INVALID_OUTPUT",
  ],
  jev: ["JEV_FAILED"],
  assets: ["ASSET_FAILED"],
  render: ["RENDER_FAILED"],
  artifact_verification: [
    "ARTIFACT_VERIFICATION_FAILED",
    "NO_VERIFIED_ARTIFACTS",
    "PROCESSING_FAILED",
  ],
});
const codeValues = Object.values(stageCodes).flat();
const uuid = z.string().uuid();
const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+(?:@[a-zA-Z0-9_-]+)?$/);
const messageFor = (stage, kind) => `${labels[stage]} ${suffixes[kind]}`;
const identityShape = {
  schema_version: z.literal(1),
  job_id: uuid,
  run_id: uuid,
  parent_job_id: uuid.optional(),
};
const stageShape = {
  kind: z.enum(PROGRESS_KINDS),
  stage: z.enum(JOB_STAGES),
  stage_instance_id: uuid,
  stage_attempt: positiveInteger.optional(),
  clip_package_id: identifier.optional(),
  treatment_id: identifier.optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  code: z.enum(codeValues).optional(),
  message: z.string(),
};
const checkIdentity = (data, ctx) => {
  if (data.run_id !== data.job_id || data.parent_job_id === data.job_id)
    ctx.addIssue({ code: "custom", message: "Invalid job identity." });
};
const checkStage = (data, ctx) => {
  if (data.message !== messageFor(data.stage, data.kind))
    ctx.addIssue({ code: "custom", message: "Invalid stage message." });
  if (
    data.code &&
    (!stageCodes[data.stage].includes(data.code) ||
      !["stage_failed", "stage_recovery"].includes(data.kind))
  )
    ctx.addIssue({ code: "custom", message: "Invalid stage code." });
};
const FactSchema = z
  .strictObject({ ...identityShape, ...stageShape, source_id: uuid })
  .superRefine(checkIdentity)
  .superRefine(checkStage);
export const ProgressDataSchema = z
  .strictObject({ ...identityShape, ...stageShape, sequence: positiveInteger })
  .superRefine(checkIdentity)
  .superRefine(checkStage);

// These are storage references, never an arbitrary local path or callback URL.
// File existence/hash verification is the result validator's responsibility.
const artifactReference = z
  .string()
  .max(1024)
  .refine(
    (reference) =>
      /^artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\/video\.mp4$/.test(reference) ||
      (/^out\/treatments\/[a-zA-Z0-9_@./-]+\.mp4$/.test(reference) &&
        reference
          .split("/")
          .every((part) => part && part !== "." && part !== "..")),
    "Invalid artifact reference.",
  );
const FailureSchema = z
  .strictObject({
    stage: z.enum(JOB_STAGES),
    code: z.enum(codeValues),
    message: z.string(),
    clip_package_id: identifier.optional(),
    treatment_id: identifier.optional(),
  })
  .superRefine((failure, ctx) =>
    checkStage({ ...failure, kind: "stage_failed" }, ctx),
  );
export const FinishedDataSchema = z
  .strictObject({
    ...identityShape,
    sequence: positiveInteger,
    status: z.enum(TERMINAL_STATUSES),
    failures: z.array(FailureSchema),
    artifacts: z.array(artifactReference),
    progress_history: z.enum(["complete", "incomplete", "unknown"]),
  })
  .superRefine(checkIdentity)
  .superRefine((data, ctx) => {
    const hasArtifacts = data.artifacts.length > 0;
    const hasFailures = data.failures.length > 0;
    if (
      (data.status === "complete" && (!hasArtifacts || hasFailures)) ||
      (data.status === "partial" && (!hasArtifacts || !hasFailures)) ||
      (["failed", "no_clips"].includes(data.status) && hasArtifacts) ||
      (data.status === "no_clips" && hasFailures)
    )
      ctx.addIssue({
        code: "custom",
        message: "Final status does not match artifacts and failures.",
      });
  });
const envelopeShape = {
  eventId: uuid,
  timestamp: z.string().datetime({ offset: true }),
  cursor: z
    .string()
    .max(8192)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable(),
};
export const EventEnvelopeSchema = z
  .discriminatedUnion("name", [
    z.strictObject({
      ...envelopeShape,
      name: z.literal(EVENT_NAMES[0]),
      data: ProgressDataSchema,
    }),
    z.strictObject({
      ...envelopeShape,
      name: z.literal(EVENT_NAMES[1]),
      data: FinishedDataSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > 64 * 1024)
      ctx.addIssue({ code: "custom", message: "Event exceeds 64 KiB." });
  });

// Do not expose validation diagnostics that may echo untrusted input values.
const parseSafe = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const oversized = result.error.issues.some(
      (issue) => issue.message === "Event exceeds 64 KiB.",
    );
    throw new Error(
      oversized ? "Event exceeds 64 KiB." : "Invalid Audiogram event contract.",
    );
  }
  return result.data;
};
const identity = (job) => {
  const data = {
    schema_version: 1,
    job_id: job?.jobId,
    run_id: job?.runId ?? job?.jobId,
    ...(job?.retryOfJobId !== undefined
      ? { parent_job_id: job.retryOfJobId }
      : {}),
  };
  return parseSafe(
    z.strictObject(identityShape).superRefine(checkIdentity),
    data,
  );
};
const safeCode = (stage, code) =>
  stageCodes[stage]?.includes(code) ? code : stageCodes[stage]?.[0];

export function projectStageFact({
  job,
  normalized,
  sourceId,
  stageInstanceId,
  stageAttempt,
}) {
  const ids = identity(job);
  if (
    !normalized ||
    (normalized.jobId !== undefined && normalized.jobId !== ids.job_id) ||
    (normalized.runId !== undefined && normalized.runId !== ids.run_id)
  )
    throw new Error("Invalid stage job identity.");
  if (internalStages.has(normalized.stage)) return null;
  const kind = statusKinds[normalized.status];
  const data = {
    ...ids,
    source_id: sourceId,
    stage_instance_id: stageInstanceId,
    stage: normalized.stage,
    kind,
    message: messageFor(normalized.stage, kind),
    ...(stageAttempt !== undefined ? { stage_attempt: stageAttempt } : {}),
    ...(normalized.clipPackageId !== undefined
      ? { clip_package_id: String(normalized.clipPackageId) }
      : {}),
    ...(normalized.treatmentId !== undefined
      ? { treatment_id: normalized.treatmentId }
      : {}),
    ...(normalized.durationMs !== undefined
      ? { duration_ms: normalized.durationMs }
      : {}),
    ...(normalized.count !== undefined ? { count: normalized.count } : {}),
    ...(["stage_failed", "stage_recovery"].includes(kind)
      ? { code: safeCode(normalized.stage, normalized.errorCode) }
      : {}),
  };
  return parseSafe(FactSchema, data);
}

export function buildProgressEvent({
  job,
  fact,
  eventId,
  sequence,
  timestamp,
}) {
  const safe = parseSafe(FactSchema, fact);
  const ids = identity(job);
  if (
    safe.job_id !== ids.job_id ||
    safe.run_id !== ids.run_id ||
    safe.parent_job_id !== ids.parent_job_id
  )
    throw new Error("Invalid stage job identity.");
  const data = { ...safe };
  delete data.source_id;
  return parseSafe(EventEnvelopeSchema, {
    eventId,
    name: EVENT_NAMES[0],
    timestamp,
    cursor: null,
    data: { ...data, sequence },
  });
}

export function buildJobFinishedEvent({
  job,
  result,
  eventId,
  sequence,
  timestamp,
  capture,
}) {
  if (
    !result ||
    !Array.isArray(result.artifacts) ||
    (result.failures !== undefined && !Array.isArray(result.failures))
  )
    throw new Error("A verified result is required.");
  const failures = (result.failures ?? []).map((failure) => {
    if (!failure || !JOB_STAGES.includes(failure.stage))
      throw new Error("Invalid failure stage.");
    return {
      stage: failure.stage,
      code: safeCode(failure.stage, failure.code),
      message: messageFor(failure.stage, "stage_failed"),
      ...(failure.packageId !== undefined
        ? { clip_package_id: String(failure.packageId) }
        : {}),
      ...(failure.treatmentId !== undefined
        ? { treatment_id: failure.treatmentId }
        : {}),
    };
  });
  return parseSafe(EventEnvelopeSchema, {
    eventId,
    name: EVENT_NAMES[1],
    timestamp,
    cursor: null,
    data: {
      ...identity(job),
      sequence,
      status: result.status,
      failures,
      artifacts: result.artifacts,
      progress_history: capture,
    },
  });
}

export function toWebhookEnvelope(event, { cursor }) {
  const safe = parseSafe(EventEnvelopeSchema, event);
  return parseSafe(EventEnvelopeSchema, { ...safe, cursor });
}
