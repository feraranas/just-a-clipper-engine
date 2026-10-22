---
name: feature-flow-diagrams
description: Maintain Mermaid feature-flow documentation through DESIGN and RECONCILE phases whenever repository behavior changes.
---

# Feature Flow Diagrams

Use this skill at the start or completion of every new feature or meaningful
behavioral change that adds or changes a pipeline, state transition, user
approval boundary, scheduled job, external integration, or persisted data
flow.

## Phase 1: DESIGN

Run before implementation.

1. Identify the feature boundary and create or update
   `docs/features/<feature>.md`.
2. Add machine-readable frontmatter with `feature`, `status: DESIGN`,
   `design-reviewed: false`, and `implementation-reconciled: false`.
   Set design-reviewed true after review, before implementation.
3. Include a Mermaid `flowchart` showing major actors, inputs,
   transformations, persistence points, and outcomes.
4. Include a Mermaid `stateDiagram-v2` when the feature has lifecycle states,
   approvals, retries, failures, or queues.
5. Document the human approval and external-side-effect boundary,
   failure/retry paths, invariants, and a brief changed/unchanged summary.
6. Do not begin implementation until the DESIGN note has been reviewed.
7. Set status IN_PROGRESS when implementation starts; retain
   implementation-reconciled false until reconciliation finishes.
8. Commit and push notes at any stage. Keep the same path. Use a pending
   statement in the reconciliation section until that work is complete.

## Phase 2: RECONCILE

Run after implementation and tests, before declaring the feature complete.

1. Inspect the actual implementation and tests.
2. Compare actual behavior with the DESIGN diagrams and written boundaries.
3. Update the note to describe actual behavior and record intentional
   deviations under implementation reconciliation.
4. Set `status: COMPLETE` and `implementation-reconciled: true` only when the
   comparison is complete; retain `design-reviewed: true`.
5. Run `npm run verify:feature-docs`. This deterministic verifier checks
   metadata and section presence only; it intentionally does not semantically
   validate Mermaid.

## Diagram and repository conventions

Keep diagrams at system-boundary level with 5–12 meaningful nodes. Use real
repository concepts and file/module names where helpful, but do not turn the
diagram into a code listing. Treat the ledger/database as a first-class node
whenever work is persisted or made idempotent. Treat rendered artifacts and
their hashes as distinct from publishing candidates. Treat approval as an
explicit transition; never imply that queueing automatically publishes.
Distinguish automated execution from human decisions and external-service
responses. Preserve failure states and diagnostic/audit outcomes instead of
drawing failures as silent termination.

For implementation work, include diagrams in the relevant feature document
or PR description/comment. Do not post externally unless explicitly asked.
When introducing a feature, announce use of this skill and create or update
the diagrams before declaring the feature complete. If a feature is too small
to warrant a diagram, state why and provide a one-sentence event → handler →
outcome summary instead.

## Required completed-note sections

Each completed note must contain headings for Mermaid flowchart,
Lifecycle/state diagram, Human approval and external-side-effect boundaries,
Failure and retry paths, Invariants, and Implementation reconciliation and
deviations. Include a brief changed/unchanged summary as well.


## Push validation and merge readiness

All stages require the documented sections. The verifier accepts DESIGN,
IN_PROGRESS and COMPLETE with consistent metadata. A successful push is not
an implementation-completion claim. Documentation-only PRs can merge with
DESIGN notes. Implementation PRs must declare their feature paths in one body
line: `Feature-docs: docs/features/<feature>.md` (comma-separated for several).
Only declared notes must be COMPLETE for PR readiness. Keep incomplete
implementation PRs in draft. Unrelated future designs do not block readiness.
For maintenance with no feature behavior, use `Feature-docs: none` and a
`Feature-docs-reason:` line; a reviewer must assess the exemption.
Do not falsely mark notes complete or bypass hooks to push unfinished work.
See AGENTS.md for the documentation-only path policy and enforcement boundary.
