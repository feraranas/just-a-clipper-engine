import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIRS = ['scripts', 'plugins/audiogram-helper', 'public/publishing'];

// Files every CI-safe run leaves out. Keep the reason next to each entry.
export const ALWAYS_SKIP = new Map([
  ['scripts/clip-selector-smoke.test.mjs', 'pairs with the live selector smoke (npm run test:selector:live)'],
]);

export function selectTestFiles(files, skip = []) {
  const skipped = new Set([...ALWAYS_SKIP.keys(), ...skip]);
  return files.filter((file) => file.endsWith('.test.mjs') && !skipped.has(file)).sort();
}

export function listTestFiles(root, dirs = TEST_DIRS) {
  return dirs.flatMap((dir) => readdirSync(join(root, dir)).map((name) => `${dir}/${name}`));
}

function main(argv) {
  const skip = argv.flatMap((arg, i) => (argv[i - 1] === '--skip' ? [arg] : []));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = selectTestFiles(listTestFiles(root), skip);
  const failed = [];
  for (const file of files) {
    const { status } = spawnSync(process.execPath, ['--test', file], { cwd: root, stdio: 'inherit' });
    if (status !== 0) failed.push(file);
  }
  console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
  for (const file of failed) console.log(`FAILED ${file}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
