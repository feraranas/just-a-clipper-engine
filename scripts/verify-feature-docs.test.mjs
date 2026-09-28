import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyFeatureDocs } from './verify-feature-docs.mjs';

async function writeFeatureDoc(root, content) {
  const features = join(root, 'docs', 'features');
  await mkdir(features, { recursive: true });
  await writeFile(join(features, 'example.md'), content);
}

const completeDoc = `---
feature: example
status: COMPLETE
design-reviewed: true
implementation-reconciled: true
---
## Mermaid flowchart
~~~mermaid
flowchart LR
 A --> B
~~~
## Lifecycle/state diagram
~~~mermaid
stateDiagram-v2
 [*] --> A
~~~
## Human approval and external-side-effect boundaries
Boundary.
## Failure and retry paths
Retry.
## Invariants
Invariant.
## Implementation reconciliation and deviations
Reconciled.
`;

test('accepts a complete feature document without parsing Mermaid semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-docs-'));
  await writeFeatureDoc(root, completeDoc);
  assert.deepEqual(verifyFeatureDocs(root), { valid: true, errors: [] });
});

test('reports missing completion metadata and required sections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-docs-'));
  await writeFeatureDoc(root, '---\nfeature: example\nstatus: DESIGN\n---\n');
  const result = verifyFeatureDocs(root);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'docs/features/example.md: design-reviewed must be true',
    'docs/features/example.md: implementation-reconciled must be true',
    'docs/features/example.md: status must be COMPLETE',
    'docs/features/example.md: missing required section "Mermaid flowchart"',
    'docs/features/example.md: missing required section "Lifecycle/state diagram"',
    'docs/features/example.md: missing required section "Human approval and external-side-effect boundaries"',
    'docs/features/example.md: missing required section "Failure and retry paths"',
    'docs/features/example.md: missing required section "Invariants"',
    'docs/features/example.md: missing required section "Implementation reconciliation and deviations"',
  ]);
});
