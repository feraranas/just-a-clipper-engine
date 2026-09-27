---
name: feature-flow-diagrams
description: Create a Mermaid feature-flow diagram and concise implementation summary whenever a new repository feature changes system behavior, state, or external boundaries.
---

# Feature Flow Diagrams

Use this skill at the start or completion of every new feature in this repository when the feature adds or changes a pipeline, state transition, user approval boundary, scheduled job, external integration, or persisted data flow.

## Required output

Produce a short feature note containing:

1. A Mermaid `flowchart` showing the major actors, inputs, transformations, persistence points, and outcomes.
2. A Mermaid `stateDiagram-v2` when the feature has lifecycle states, approvals, retries, failures, or queues.
3. A brief “changed / unchanged” summary.
4. The explicit human approval boundary, if any.
5. At least one failure or retry path when the feature can fail.

Keep diagrams at system-boundary level: use real repository concepts and file/module names where helpful, but do not turn the diagram into a code listing. Prefer 5–12 meaningful nodes per diagram. Use labels that explain events and outcomes rather than implementation trivia.

## Repository conventions

- Treat the ledger/database as a first-class node whenever work is persisted or made idempotent.
- Treat rendered artifacts and their hashes as distinct from publishing candidates.
- Treat approval as an explicit transition; never imply that queueing automatically publishes.
- Distinguish automated execution from human decisions and external-service responses.
- Preserve failure states and diagnostic/audit outcomes instead of drawing failures as silent termination.

## Where to put the result

For implementation work, include the diagrams in the relevant feature documentation or PR description/comment. If the user explicitly asks to post them to a PR, post the Mermaid fenced blocks using the repository’s GitHub tooling and verify the resulting comment URL. Do not post externally without that explicit request.

For a small feature, the diagrams may live in the PR comment only. For a durable architectural change, also add or update a repository-local document under `docs/` and link it from the PR.

## Invocation expectation

When introducing a new feature, announce that this skill is being used and create or update the diagrams before declaring the feature complete. If the feature is too small to warrant a diagram, state why and provide a one-sentence event → handler → outcome summary instead.
