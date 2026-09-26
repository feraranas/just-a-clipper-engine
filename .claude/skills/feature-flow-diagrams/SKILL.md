---
name: feature-flow-diagrams
description: Maintain a two-ended DESIGN and RECONCILE lifecycle for feature-flow documentation.
---

# Feature Flow Diagrams

Use this skill for every new feature or meaningful behavioral change that adds
or changes a pipeline, state transition, user approval boundary, scheduled
job, external integration, or persisted data flow.

## Phase 1: DESIGN

Run before implementation.

1. Identify the feature boundary and create or update
   `docs/features/<feature>.md`.
2. Add machine-readable frontmatter with `feature`, `status: DESIGN`,
   `design-reviewed: true`, and `implementation-reconciled: false`.
3. Document the intended Mermaid flowchart, lifecycle/state diagram when
   applicable, human approval and external-side-effect boundaries,
   failure/retry paths, and invariants.
4. Do not begin implementation until the DESIGN note has been reviewed.

## Phase 2: RECONCILE

Run after implementation and tests, before declaring the feature complete.

1. Inspect the actual implementation and tests.
2. Compare actual behavior with the DESIGN diagrams and written boundaries.
3. Update the note to describe actual behavior and record intentional
   deviations under implementation reconciliation.
4. Set `status: COMPLETE` and `implementation-reconciled: true` only when the
   comparison is complete; retain `design-reviewed: true`.
5. Run `npm run verify:feature-docs`. This verifier checks metadata and section
   presence only; it intentionally does not semantically validate Mermaid.

## Required note sections

Each completed note must contain headings for Mermaid flowchart,
Lifecycle/state diagram, Human approval and external-side-effect boundaries,
Failure and retry paths, Invariants, and Implementation reconciliation and
deviations. Include a `stateDiagram-v2` when the feature has lifecycle states,
approvals, retries, failures, or queues.

Keep diagrams at system-boundary level. Show automated execution, human
decisions, external-service responses, persistence/idempotency, and failure
states explicitly. Approval must never imply automatic publishing or another
external side effect.
