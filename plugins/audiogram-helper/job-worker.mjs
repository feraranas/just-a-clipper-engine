import {resolveTemplateSelection} from "../../src/templates/catalog.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createJobStore } from './job-store.mjs';
import { validateCliResult } from './result-validation.mjs';

export async function runJobWorker({ jobId, sourceUrl, templateSelection, projectRoot, jobStorePath, runCommand }) {
  const store = createJobStore(jobStorePath);
  try {
    const job = store.getJob(jobId);
    if (!job) throw new Error('Job does not exist.');
    try {
      const resolved=resolveTemplateSelection(job.selection);
      if (job.renderKey !== resolved.renderKey) throw new Error('Stored render identity does not match selection');
      if (templateSelection !== undefined && resolveTemplateSelection(templateSelection).renderKey !== resolved.renderKey) throw new Error('Worker selection does not match stored job');
      const selection=resolved.selection;
      const args=[path.join(projectRoot, 'scripts/audiogram-url.mjs'), '--url', sourceUrl,
        '--template', selection.templateId, '--template-version', selection.templateVersion, '--variation', selection.variationId];
      const output = await (runCommand ?? (() => promisify(execFile)(process.execPath, args, {cwd: projectRoot, env: process.env, maxBuffer: 8 * 1024 * 1024})))();
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
  const { values } = parseArgs({ options: { 'job-id': { type: 'string' }, url: { type: 'string' }, template:{type:'string'}, 'template-version':{type:'string'}, variation:{type:'string'} }, strict: true });
  const projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd();
  const storePath = process.env.AUDIOGRAM_JOB_STORE ?? path.join(projectRoot, '.local', 'audiogram-helper-jobs.sqlite');
  const templateSelection={};
  for(const [flag,key] of [['template','templateId'],['template-version','templateVersion'],['variation','variationId']]) if(values[flag]!==undefined)templateSelection[key]=values[flag];
  await runJobWorker({ templateSelection: Object.keys(templateSelection).length ? templateSelection : undefined, jobId: values['job-id'], sourceUrl: values.url, projectRoot, jobStorePath: storePath });
}
