import { resolveStorageConfig } from "../../scripts/storage-config.mjs";
import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createJobStore } from "./job-store.mjs";
import { createJobDiagnostics } from "./job-diagnostics.mjs";
import { validateCliResult } from "./result-validation.mjs";

const CONTRACT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_LOG_LIMIT = 2 * 1024 * 1024;

function boundedLimit(environment) {
  const configured = Number(environment.AUDIOGRAM_DIAGNOSTICS_MAX_FILE_BYTES);
  return Number.isInteger(configured) &&
    configured >= 1024 &&
    configured <= 50 * 1024 * 1024
    ? configured
    : DEFAULT_LOG_LIMIT;
}

export function boundProcessOutput({
  stdout = process.stdout,
  stderr = process.stderr,
  maxFileBytes,
}) {
  let incomplete = false;
  for (const stream of [stdout, stderr]) {
    const write = stream.write.bind(stream);
    let bytesWritten = 0;
    stream.write = (chunk, encoding, callback) => {
      const callbackFn = typeof encoding === "function" ? encoding : callback;
      const textEncoding = typeof encoding === "string" ? encoding : undefined;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), textEncoding);
      const allowed = Math.max(
        0,
        Math.min(buffer.length, maxFileBytes - bytesWritten),
      );
      bytesWritten += allowed;
      if (allowed < buffer.length) {
        incomplete = true;
      }
      if (!allowed) {
        callbackFn?.();
        return true;
      }
      return write(buffer.subarray(0, allowed), callbackFn);
    };
  }
  return () => incomplete;
}

function executeCli({
  command,
  args,
  cwd,
  env,
  diagnostics,
  maxFileBytes,
  spawnProcess = spawn,
}) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stdoutBytes = 0;
    let diagnosticsIncomplete = false;
    let stdoutFd;
    let stderrFd;
    try {
      stdoutFd = openSync(diagnostics.files.pipelineStdout, "w", 0o600);
      stderrFd = openSync(diagnostics.files.pipelineStderr, "w", 0o600);
    } catch {
      diagnosticsIncomplete = true;
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      stdoutFd = stderrFd = undefined;
    }
    let descriptorsClosed = false;
    const closeDescriptors = () => {
      if (descriptorsClosed) return;
      descriptorsClosed = true;
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    };
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      closeDescriptors();
      reject(error);
      return;
    }
    const record = (fd, chunk, isStdout) => {
      const remaining = Math.max(
        0,
        maxFileBytes - (isStdout ? stdoutBytes : record.stderrBytes),
      );
      const keepLength = Math.min(remaining, chunk.length);
      if (keepLength < chunk.length) diagnosticsIncomplete = true;
      if (keepLength > 0 && fd !== undefined) {
        try {
          writeSync(fd, chunk.subarray(0, keepLength));
        } catch {
          diagnosticsIncomplete = true;
        }
      }
      if (isStdout) {
        stdoutBytes += chunk.length;
        if (stdout.length < CONTRACT_LIMIT) {
          stdout = Buffer.concat([
            stdout,
            chunk.subarray(
              0,
              Math.min(chunk.length, CONTRACT_LIMIT - stdout.length),
            ),
          ]);
        }
        if (stdoutBytes > CONTRACT_LIMIT) diagnosticsIncomplete = true;
      } else record.stderrBytes += chunk.length;
    };
    record.stderrBytes = 0;
    child.stdout.on("data", (chunk) => record(stdoutFd, chunk, true));
    child.stderr.on("data", (chunk) => record(stderrFd, chunk, false));
    child.once("error", (error) => {
      closeDescriptors();
      reject(error);
    });
    child.once("close", (code, signal) => {
      closeDescriptors();
      if (code === 0)
        resolve({
          stdout: stdout.toString("utf8"),
          stderr: "",
          diagnosticsIncomplete,
        });
      else
        reject(
          Object.assign(new Error("CLI process failed."), {
            code: code ?? signal ?? "UNKNOWN",
            stdout: stdout.toString("utf8"),
            diagnosticsIncomplete,
          }),
        );
    });
  });
}

export async function runJobWorker({
  jobId,
  sourceUrl,
  templateSelection,
  projectRoot,
  jobStorePath,
  diagnosticsRoot,
  environment = process.env,
  runCommand,
  spawnProcess = spawn,
  isWorkerOutputIncomplete = () => false,
}) {
  const store = createJobStore(jobStorePath);
  let diagnosticsIncomplete =
    environment.AUDIOGRAM_DIAGNOSTICS_INCOMPLETE === "1";
  try {
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job does not exist.");
    const resolved = resolveTemplateSelection(job.selection);
    if (
      job.renderKey !== resolved.renderKey ||
      (templateSelection !== undefined &&
        resolveTemplateSelection(templateSelection).renderKey !==
          resolved.renderKey)
    )
      throw new Error("Worker selection does not match stored job");
    const diagnostics = createJobDiagnostics({
      projectRoot,
      diagnosticsRoot,
      jobId,
    });
    await diagnostics.ready;
    const args = [
      path.join(projectRoot, "scripts/audiogram-url.mjs"),
      "--url",
      sourceUrl,
      "--job-id",
      jobId,
    ];
    args.push(
      "--template",
      resolved.selection.templateId,
      "--template-version",
      resolved.selection.templateVersion,
      "--variation",
      resolved.selection.variationId,
    );
    if (job.retryOfJobId) args.push("--retry");
    const childEnvironment = {
      ...environment,
      AUDIOGRAM_PROJECT_ROOT: projectRoot,
      AUDIOGRAM_DIAGNOSTICS_ROOT: diagnostics.root,
      ...(diagnosticsIncomplete
        ? { AUDIOGRAM_DIAGNOSTICS_INCOMPLETE: "1" }
        : {}),
    };
    try {
      const output = await (runCommand
        ? runCommand({ args, env: childEnvironment, diagnostics })
        : executeCli({
            command: process.execPath,
            args,
            cwd: projectRoot,
            env: childEnvironment,
            diagnostics,
            maxFileBytes: boundedLimit(environment),
            spawnProcess,
          }));
      const contract = JSON.parse(output.stdout.trim());
      let result;
      try {
        result = await validateCliResult(contract, projectRoot, {
          artifactRoot: resolveStorageConfig(environment).artifactRoot,
        });
      } catch {
        throw Object.assign(new Error("CLI result validation failed."), {
          code: "CLI_CONTRACT_INVALID",
        });
      }
      store.setResult(jobId, {
        ...result,
        diagnosticsIncomplete: Boolean(
          output.diagnosticsIncomplete ||
          result.diagnosticsIncomplete ||
          diagnosticsIncomplete ||
          diagnostics.diagnosticsIncomplete ||
          isWorkerOutputIncomplete(),
        ),
      });
    } catch (error) {
      const invalidContract = error?.code === "CLI_CONTRACT_INVALID";
      const contractFailure = error instanceof SyntaxError || invalidContract;
      store.setResult(jobId, {
        status: "failed",
        title: null,
        artifacts: [],
        error: "Audiograms worker failed.",
        failures: [
          {
            stage: "worker",
            code: contractFailure
              ? "CLI_CONTRACT_INVALID"
              : "WORKER_PROCESS_FAILED",
            message: invalidContract
              ? "The CLI result was invalid."
              : error instanceof SyntaxError
                ? "The CLI result could not be read."
                : "The CLI process did not complete.",
          },
        ],
        diagnosticsIncomplete: Boolean(
          error?.diagnosticsIncomplete ||
          diagnostics.diagnosticsIncomplete ||
          isWorkerOutputIncomplete(),
        ),
      });
    }
  } catch {
    try {
      store.setFailed(jobId, "Audiograms worker could not record its result.");
    } catch {
      /* preserve original process outcome */
    }
  } finally {
    store.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      "job-id": { type: "string" },
      url: { type: "string" },
      template: { type: "string" },
      "template-version": { type: "string" },
      variation: { type: "string" },
    },
    strict: true,
  });
  const projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd();
  const storePath =
    process.env.AUDIOGRAM_JOB_STORE ??
    path.join(projectRoot, ".local", "audiogram-helper-jobs.sqlite");
  const isWorkerOutputIncomplete = boundProcessOutput({
    maxFileBytes: boundedLimit(process.env),
  });
  const templateSelection = {};
  for (const [flag, key] of [
    ["template", "templateId"],
    ["template-version", "templateVersion"],
    ["variation", "variationId"],
  ])
    if (values[flag] !== undefined) templateSelection[key] = values[flag];
  await runJobWorker({
    templateSelection: Object.keys(templateSelection).length
      ? templateSelection
      : undefined,
    jobId: values["job-id"],
    sourceUrl: values.url,
    projectRoot,
    jobStorePath: storePath,
    diagnosticsRoot: process.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
    isWorkerOutputIncomplete,
  });
}
