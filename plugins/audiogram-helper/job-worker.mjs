import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createJobStore } from './job-store.mjs';
import { validateCliResult } from './result-validation.mjs';

export async function runJobWorker({ jobId, sourceUrl, projectRoot, jobStorePath, runCommand = async () => promisify(execFile)(process.execPath, [path.join(projectRoot, 'scripts/audiogram-url.mjs'), '--url', sourceUrl], { cwd: projectRoot, env: process.env, maxBuffer: 8 * 1024 * 1024 }) }) {
  const store = createJobStore(jobStorePath);
  try {
    const job = store.getJob(jobId);
    if (!job) throw new Error('Job does not exist.');
    try {
      const output = await runCommand();
      const contract = JSON.parse(output.stdout.trim());
      const result = await validateCliResult(contract, projectRoot);
      store.setResult(jobId, result);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      store.setFailed(jobId, `Audiograms worker failed (${code}).`);
    }
  } catch {
    try { store.setFailed(jobId, 'Audiograms worker could not record its result.'); } catch { /* preserve original process outcome */ }
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'job-id': { type: 'string' }, url: { type: 'string' } }, strict: true });
  const projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd();
  const storePath = process.env.AUDIOGRAM_JOB_STORE ?? path.join(projectRoot, '.local', 'audiogram-helper-jobs.sqlite');
  await runJobWorker({ jobId: values['job-id'], sourceUrl: values.url, projectRoot, jobStorePath: storePath });
}
