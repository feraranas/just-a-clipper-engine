# Explainer scenes and workflow implementation plan

> Execute inline with superpowers:executing-plans. The user authorized steps 1–4; no subagents.

**Goal:** Render a selected topic through saved research, script and voice approvals, and reusable scenes.
**Architecture:** Extend the candidate review record using atomic updates; retain artifacts under shared storage. Reuse the existing generation transport with an explicit task contract, TTS helper, Rhubarb and Remotion.
**Tech Stack:** Existing Node, SQLite, Zod, React and Remotion; no new packages.
**Spec:** docs/features/explainer-scenes-workflow.md

## Constraints and review focus

Keep personal assets local. Never infer a new candidate/script/audio approval. Do not auto-retry paid requests. Validate citations, stale hashes, concurrent updates, script/audio mismatch, unsupported blocks and duration bounds. Research enters as passages gathered by the calling assistant; web search is not added to the worker.

## Tasks

- [x] Commit and push the twenty-mouth presenter; reuse the candidate-review commit.
- [x] Add src/Explainer/catalog.mjs with strict comparison/process/branch schemas and src/Explainer/SceneBlock.tsx animations. Test bounds and unknown blocks.
- [x] Add src/Explainer/Main.tsx accepting runtime scenes/audio/cues/artwork. Render the approved sample with improved diagrams.
- [x] Extend scripts/candidate-review.mjs with atomic record updates. Add scripts/explainer/workflow.mjs for immutable research/script/audio/scene revisions and exact approvals. Test gates, stale approvals and concurrency.
- [x] Extend the existing structured provider with an explicit task contract without weakening the selector contract. Add CLI and MCP commands for existing review IDs; test discovery and provider requests.
- [x] Reuse saved approved sample through the actual workflow and render; verify media and Classic fixture. Reconcile docs.
- [ ] Commit, push and update the PR after the normal verification hook passes.
