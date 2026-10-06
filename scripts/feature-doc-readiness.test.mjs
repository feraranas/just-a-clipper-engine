import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFeatureReadiness } from './feature-doc-readiness.mjs';

const path = 'docs/features/example.md';
const complete = '---\nfeature: example\nstatus: COMPLETE\ndesign-reviewed: true\nimplementation-reconciled: true\n---\n';
const design = complete.replace('COMPLETE', 'DESIGN').replace('implementation-reconciled: true', 'implementation-reconciled: false');
const check = (body, files, note = complete) => checkFeatureReadiness({ body, files, readDocument: p => { assert.equal(p, path); return note; } });

test('design-only PR can merge with unfinished notes', () => {
 assert.deepEqual(check('', [{filename: path}], design), []);
});
test('code changes require explicit feature mapping', () => {
 assert.match(check('', [{filename: 'src/app.ts'}])[0], /Feature-docs/);
});
test('declared completed feature permits implementation readiness', () => {
 assert.deepEqual(check(`Feature-docs: ${path}`, [{filename: 'src/app.ts'}]), []);
});
test('declared unfinished feature blocks implementation readiness', () => {
 assert.match(check(`Feature-docs: ${path}`, [{filename: 'src/app.ts'}], design)[0], /COMPLETE/);
});
test('unrelated designs are not read', () => {
 assert.deepEqual(check(`Feature-docs: ${path}`, [{filename: 'src/app.ts'}, {filename: 'docs/features/future.md'}]), []);
});
test('renaming code to markdown is not documentation-only', () => {
 assert.ok(check('', [{filename: path, previous_filename: 'src/app.ts'}]).length);
});
test('workflow and skill changes require explicit mapping', () => {
 for (const filename of ['.github/workflows/pr.yml', '.claude/skills/example/SKILL.md']) assert.ok(check('', [{filename}]).length);
});
test('non-feature exception requires a reason', () => {
 assert.ok(check('Feature-docs: none', [{filename: 'package.json'}]).length);
 assert.deepEqual(check('Feature-docs: none\nFeature-docs-reason: Dependency patch only.', [{filename: 'package.json'}]), []);
});
test('rejects unsafe paths, duplicate declarations and mixed none', () => {
 for (const body of ['Feature-docs: ../../secret', `Feature-docs: ${path}\nFeature-docs: none`, `Feature-docs: none, ${path}`, 'Feature-docs: docs/features/../other.md']) assert.ok(check(body, [{filename: 'src/app.ts'}]).length);
});
test('missing or deleted declared note fails', () => {
 assert.ok(checkFeatureReadiness({body: `Feature-docs: ${path}`, files: [{filename: path, status: 'removed'}, {filename: 'src/app.ts'}], readDocument: () => {throw Error('ENOENT');}}).length);
});
test('multiple declared features must all be complete', () => {
 const errors = checkFeatureReadiness({body: `Feature-docs: ${path}, docs/features/second.md`, files: [{filename: 'src/app.ts'}], readDocument: p => p === path ? complete : design});
 assert.equal(errors.length, 1);
 assert.match(errors[0], /second.md/);
});

test('accepts GitHub CRLF bodies', () => {
 assert.deepEqual(check('Intro\r\nFeature-docs: none\r\nFeature-docs-reason: Dependency patch only.\r\n', [{filename: 'package.json'}]), []);
});
