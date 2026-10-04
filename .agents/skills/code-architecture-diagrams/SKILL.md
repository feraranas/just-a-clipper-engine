---
name: code-architecture-diagrams
description: Use only when the user explicitly asks for a runtime call-flow diagram, including for a pull request. Do not trigger for general code explanations, architecture questions, PR reviews, or Mermaid requests without that explicit diagram request.
---

# Code Architecture Diagrams

Trigger only on an explicit request for a runtime call-flow diagram. A request to explain code, discuss architecture patterns, review a PR, or produce another kind of diagram is not sufficient by itself. Once triggered, trace actual calls and boundaries from source. For pull requests, show changed code in the context of surrounding behavior, not as an isolated diff.

## Workflow

1. Establish the repository and revision. For a PR, inspect the base-to-head diff, then follow relevant callers, callees, tests, and configuration beyond changed lines. Never assume the checkout is the PR head.
2. Trace concrete entrypoints (route, tool, CLI, UI event, worker, or queue) through verified calls. Note file paths, functions, explicit or implicit contracts, data crossing boundaries, persistence, async/process boundaries, and external effects. Names alone do not prove a call relationship.
3. Draw the smallest useful Mermaid `flowchart` for runtime calls and responsibilities. Group modules by role when useful. Label nodes with repository-relative paths and function/interface names; put signatures and data shapes in nodes. For PRs, distinguish changed code from context and show how the changed path enters and rejoins existing behavior.
4. Answer the user's specific call-flow hypotheses directly. Explain patterns only as supported by code; identify implicit boundaries and distinguish observed facts from interpretation. Link useful source files and state unverified edges. Keep the diagram inline unless asked to save it.

## Mermaid compatibility

- Prefer `flowchart LR` or `flowchart TD`, quoted node labels, and plain arrows. Keep edge labels to short verbs; put function names/signatures in nodes. Some renderers parse parentheses in edge labels as shape syntax.
- Avoid code expressions, nested brackets, and decorative edge syntax. Use conservative syntax unless the target renderer/version is known.
- Show async spawn/queue and later result as separate steps; don't imply a synchronous return for detached work.

## Architecture interpretation

Use these distinctions when relevant:

- A route/tool/transport is an inbound adapter, not automatically the entrypoint for every downstream workflow. A sequence-coordinating module is an orchestrator only for that sequence.
- Call a contract a port when consumers rely on it and implementations are substitutable. If it is a duck-typed object, call it implicit/structural. A database wrapper may be a persistence adapter; don't invent a separate repository port.
- Frameworks/SDKs provide protocol or runtime primitives; layering and ports-and-adapters are separate design decisions.

## Output shape

1. One-sentence orientation to the entrypoint or PR change.
2. Mermaid call flow with paths, functions/interfaces, and boundaries.
3. Direct answers to the user's hypotheses, source links, and caveats.
