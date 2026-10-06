import { resolveTemplateSelectionConfig } from "./template-selection-config.mjs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runSingleUrlPipeline } from "./single-url-pipeline.mjs";
import {
  createJobDiagnostics,
  validateJobId,
} from "../plugins/audiogram-helper/job-diagnostics.mjs";

const usage =
  "Usage: node scripts/audiogram-url.mjs --url <youtube-video-url> [--template classic --template-version 1 --variation default] [--retry-failed-renders | --retry]";

export const runAudiogramUrlCli = async (
  args = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
  dependencies = {},
) => {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        url: { type: "string" },
        "job-id": { type: "string" },
        retry: { type: "boolean" },
        template: { type: "string" },
        "template-version": { type: "string" },
        variation: { type: "string" },
        "retry-failed-renders": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    io.stderr.write(`${error.message}\n${usage}\n`);
    return 2;
  }

  const url = parsed.values.url;
  if (typeof url !== "string" || url.trim() === "") {
    io.stderr.write(`--url is required.\n${usage}\n`);
    return 2;
  }

  const jobId = parsed.values["job-id"];
  if (jobId !== undefined) {
    try {
      validateJobId(jobId);
    } catch (error) {
      io.stderr.write(`${error.message}\n${usage} [--job-id <UUID>]\n`);
      return 2;
    }
  }

  let result;
  let diagnostics;
  try {
    const projectRoot =
      dependencies.projectRoot ??
      process.env.AUDIOGRAM_PROJECT_ROOT ??
      process.cwd();
    const environment = dependencies.environment ?? process.env;
    const request = {};
    for (const [flag, key] of [
      ["template", "templateId"],
      ["template-version", "templateVersion"],
      ["variation", "variationId"],
    ])
      if (parsed.values[flag] !== undefined) request[key] = parsed.values[flag];
    const resolved = resolveTemplateSelectionConfig({ request, environment });
    diagnostics =
      jobId === undefined
        ? null
        : createJobDiagnostics({
            projectRoot,
            diagnosticsRoot: environment.AUDIOGRAM_DIAGNOSTICS_ROOT,
            jobId,
          });
    await diagnostics?.ready;
    const pipelineDependencies = {
      ...(dependencies.pipelineDependencies ?? {}),
    };
    if (diagnostics) pipelineDependencies.onEvent = diagnostics.logger.event;
    if (parsed.values.retry) pipelineDependencies.retryFailedPipeline = true;
    result = await (dependencies.runPipeline ?? runSingleUrlPipeline)({
      url,
      templateSelection: resolved.selection,
      retryFailedRenders: parsed.values["retry-failed-renders"],
      projectRoot,
      environment,
      dependencies: pipelineDependencies,
    });
  } catch (error) {
    result = {
      contractVersion: 1,
      status: "failed",
      source: null,
      artifactPaths: [],
      error: {
        code:
          error?.code === "INVALID_TEMPLATE_SELECTION"
            ? error.code
            : "RUNNER_FAILED",
        message:
          error?.code === "INVALID_TEMPLATE_SELECTION"
            ? error.message
            : "Audiograms could not complete the request.",
      },
    };
  }

  if (diagnostics?.diagnosticsIncomplete)
    result = { ...result, diagnosticsIncomplete: true };

  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runAudiogramUrlCli();
}
