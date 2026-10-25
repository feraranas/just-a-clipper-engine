import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { listTestFiles, selectTestFiles } from './run-ci-tests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('selects only test files, sorted, without the live selector smoke', () => {
  assert.deepEqual(
    selectTestFiles(['scripts/b.test.mjs', 'scripts/a.mjs', 'scripts/clip-selector-smoke.test.mjs', 'public/publishing/a.test.mjs']),
    ['public/publishing/a.test.mjs', 'scripts/b.test.mjs'],
  );
});

test('extra skips are honored', () => {
  assert.deepEqual(selectTestFiles(['scripts/a.test.mjs', 'scripts/b.test.mjs'], ['scripts/b.test.mjs']), ['scripts/a.test.mjs']);
});

test('covers the plugin and publishing UI tests, not just scripts/', () => {
  const files = selectTestFiles(listTestFiles(root));
  assert.ok(files.includes('plugins/audiogram-helper/server.test.mjs'));
  assert.ok(files.includes('public/publishing/app.test.mjs'));
  assert.ok(files.includes('scripts/run-ci-tests.test.mjs'));
});
