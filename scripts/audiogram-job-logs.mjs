import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  readJobDiagnostics,
  validateJobId,
} from "../plugins/audiogram-helper/job-diagnostics.mjs";

export async function runAudiogramJobLogsCli(
  args = process.argv.slice(2),
  {
    projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd(),
    diagnosticsRoot = process.env.AUDIOGRAM_DIAGNOSTICS_ROOT,
    io = { stdout: process.stdout, stderr: process.stderr },
  } = {},
) {
  let values;
  try {
    values = parseArgs({
      args,
      options: { "job-id": { type: "string" }, limit: { type: "string" } },
      strict: true,
    }).values;
    validateJobId(values["job-id"]);
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("limit must be an integer between 1 and 1000");
    const result = await readJobDiagnostics({
      projectRoot,
      diagnosticsRoot,
      jobId: values["job-id"],
      limit,
    });
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `${error?.message === "jobId must be a valid UUID" ? error.message : "Unable to read Audiogram diagnostics."}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runAudiogramJobLogsCli();
