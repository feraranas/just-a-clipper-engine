import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function validateCliResult(result, projectRoot) {
  if (!result || result.contractVersion !== 1 || !['complete', 'no_clips', 'failed', 'partial'].includes(result.status)) throw new Error('Invalid Audiograms result contract.');
  const failures = Array.isArray(result.failures)
    ? result.failures.slice(0, 50).flatMap((failure) => {
        if (!failure || !['worker', 'intake', 'metadata', 'transcript', 'selection', 'jev', 'assets', 'render', 'artifact_verification'].includes(failure.stage)) return [];
        if (typeof failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(failure.code)) return [];
        return [{
          stage: failure.stage,
          code: failure.code,
          message: typeof failure.message === 'string' ? failure.message.slice(0, 240) : 'Audiogram stage failed.',
          ...((typeof failure.packageId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(failure.packageId)) || Number.isSafeInteger(failure.packageId)
            ? { packageId: String(failure.packageId) }
            : {}),
        }];
      })
    : [];
  if (result.status === 'failed' || result.status === 'no_clips')
    return { status: result.status, title: result.source?.title ?? null, artifacts: [], ...(failures.length ? { failures } : {}), ...(result.retryOfJobId ? { retryOfJobId: result.retryOfJobId } : {}), diagnosticsIncomplete: Boolean(result.diagnosticsIncomplete), error: result.status === 'no_clips' ? 'No clips were selected from this video.' : failures[0]?.message ?? 'Audiogram processing failed.' };
  if (!Array.isArray(result.artifactPaths) || result.artifactPaths.length === 0) throw new Error('Result has no artifacts.');
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
  if (result.status === 'partial' && artifacts.length === 0) throw new Error('Partial result has no verified artifacts.');
  return {
    status: result.status,
    title: result.source?.title ?? null,
    artifacts,
    ...(failures.length ? { failures } : {}),
    ...(result.retryOfJobId ? { retryOfJobId: result.retryOfJobId } : {}),
    diagnosticsIncomplete: Boolean(result.diagnosticsIncomplete),
    error: typeof result.error?.message === 'string' ? result.error.message.slice(0, 240) : null,
  };
}
