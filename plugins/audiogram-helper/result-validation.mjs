import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function validateCliResult(result, projectRoot) {
  if (!result || result.contractVersion !== 1 || !['complete', 'no_clips', 'failed'].includes(result.status)) throw new Error('Invalid Audiograms result contract.');
  if (result.status !== 'complete') return { status: result.status, title: result.source?.title ?? null, artifacts: [], error: result.error?.message ?? null };
  if (!Array.isArray(result.artifactPaths) || result.artifactPaths.length === 0) throw new Error('Completed result has no artifacts.');
  const canonicalProjectRoot = await realpath(projectRoot);
  const expectedRoot = path.join(canonicalProjectRoot, 'out', 'treatments');
  const root = await realpath(path.resolve(projectRoot, 'out/treatments'));
  if (root !== expectedRoot) throw new Error('Treatments output directory must not be a symlink.');
  const artifacts = [];
  for (const relative of result.artifactPaths) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Artifact path is invalid.');
    const absolute = path.resolve(projectRoot, relative);
    const actual = await realpath(absolute);
    if (!actual.startsWith(`${root}${path.sep}`) || path.extname(actual).toLowerCase() !== '.mp4') throw new Error('Artifact path is outside the treatments directory.');
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0) throw new Error('Artifact is missing or empty.');
    artifacts.push(path.normalize(relative).split(path.sep).join('/'));
  }
  return { status: 'complete', title: result.source?.title ?? null, artifacts, error: null };
}
