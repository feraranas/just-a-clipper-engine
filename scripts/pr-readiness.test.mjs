import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const entry = new URL('./pr-readiness.mjs', import.meta.url).href;
function run({draft = false, count = 1, fail = false, incomplete = false, conflict = false} = {}) {
 const pull = {body: '', draft, changed_files: count, state: 'open', mergeable: !conflict};
 const script = `globalThis.fetch = async (url) => {
   if (!url.includes('/files?')) return {ok: true, json: async () => (${JSON.stringify(pull)})};
   if (${fail}) return {ok: false, status: 503};
   const page = Number(new URL(url).searchParams.get('page'));
   const n = ${incomplete} ? 0 : Math.max(0, Math.min(100, ${count} - (page - 1) * 100));
   return {ok: true, json: async () => Array.from({length: n}, (_,i) => ({filename: 'docs/plan-' + page + '-' + i + '.md'}))};
 }; await import(${JSON.stringify(entry)});`;
 return spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', env: {...process.env, GITHUB_REPOSITORY: 'test/repo', PR_NUMBER: '30', GH_TOKEN: 'fake-test-token'}});
}
test('readiness permits a design-only PR and paginates changed files', () => {
 const result = run({count: 101});
 assert.equal(result.status, 0, result.stderr);
});
test('draft and conflicting PRs are not merge-ready', () => {
 for (const config of [{draft: true}, {conflict: true}]) { const result = run(config); assert.notEqual(result.status, 0); assert.match(result.stderr, /is not ready/); }
});
test('lookup errors and incomplete file lists fail closed', () => {
 for (const config of [{fail: true}, {incomplete: true}]) { const result = run(config); assert.notEqual(result.status, 0); assert.match(result.stderr, /lookup failed|incomplete/); }
});
