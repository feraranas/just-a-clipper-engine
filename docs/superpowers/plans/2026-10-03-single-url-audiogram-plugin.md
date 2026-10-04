# Single URL Audiogram Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept one YouTube video URL in ChatGPT Developer Mode and return captioned MP4 clip drafts rendered by the Audiograms engine.

**Architecture:** Run a local Streamable HTTP MCP service at `/mcp` and connect it to ChatGPT Developer Mode through OpenAI Secure MCP Tunnel; the tunnel keeps the development service private and is not a production host. Keep URL validation, job orchestration, and rendering behind a stable Audiograms command/runner contract, with the MCP service responsible only for validation, dispatch, status/result shaping, and artifact verification. Later, keep the same MCP tools and result schema while replacing the local runner and filesystem artifacts with a Cloud Run service/Job runner and Cloud Storage artifacts; cloud deployment and public listing are explicitly out of this implementation.

**Tech Stack:** Node.js 22, Node built-in test runner, Audiograms pipeline and Remotion treatment, Streamable HTTP transport from the current Model Context Protocol TypeScript SDK, existing Zod dependency, OpenAI Secure MCP Tunnel for local ChatGPT testing.

**Spec:** `docs/superpowers/specs/2026-10-03-single-url-audiogram-plugin-design.md`

## Global Constraints

- V1 accepts one publicly accessible YouTube video URL per request.
- Keep the existing Most Replayed heatmap selection default and all current explicit selection configuration behavior.
- Keep rendered MP4s and the local ledger on the developer machine; do not upload or publish.
- ChatGPT connects to a loopback-only local HTTP MCP endpoint through Secure MCP Tunnel; do not expose a public listener or store tunnel credentials in the repository.
- Use Streamable HTTP at `/mcp`; keep MCP input/output independent of the local execution adapter so a future Cloud Run runner can preserve the contract.
- The local MCP adapter invokes the stable Audiograms command/runner contract, not internal selection/render modules.
- Preserve unrelated work in the user's original checkout; this implementation runs only in the isolated worktree.
- Require Node.js 22, yt-dlp, FFmpeg, and ffprobe as applicable to the existing pipeline.
- Cloud Run, Cloud Storage, public plugin submission, and production credentials are not part of this implementation.

## Review Focus

- Non-YouTube host or unsupported path: reject before invoking yt-dlp; cover in URL-core tests.
- URL has playlist parameters: process only the identified video with no-playlist semantics; cover in URL-core and command tests.
- Metadata is malformed or identifies another video: fail before creating a processing job; cover in pipeline tests.
- Captions/heatmap are unavailable or selection yields no clips: return an explicit non-success terminal result and no artifact claims; cover in pipeline tests.
- MCP request reaches a non-loopback host or malformed request: refuse it; cover HTTP transport tests.
- Runner exits abnormally, result JSON is invalid, or artifact path escapes the output directory/is empty: return a tool error and never report completion; cover adapter tests.
- Local service restarts or a job fails partway through rendering: status remains honest and retry behavior follows the Audiograms ledger; cover lifecycle tests.

## File Structure

- `scripts/youtube-url-core.mjs` and `.test.mjs` — accepted URL parsing, normalization, and metadata identity checks.
- `scripts/single-url-pipeline.mjs` and `.test.mjs` — direct single-video orchestration reusing selection, ledger, asset, render, and local approval queue behavior.
- `scripts/audiogram-url.mjs` and `.test.mjs` — stable versioned JSON command contract used by the MCP adapter.
- `plugins/audiogram-helper/server.mjs` and `.test.mjs` — Streamable HTTP `/mcp` service, two focused tools (`create_audiogram`, `get_audiogram_status`), and local protocol/lifecycle coverage.
- `plugins/audiogram-helper/job-store.mjs`, `local-runner.mjs`, `job-worker.mjs`, `result-validation.mjs` — SQLite persistence, detached CLI worker lifecycle, and artifact validation behind a transport-neutral runner boundary.
- `plugins/audiogram-helper/README.md` — local prerequisites, loopback service startup, Secure MCP Tunnel/Developer Mode connection steps, and local-only limitations; no credentials.
- `package.json`, `package-lock.json` — command aliases and only the SDK dependencies required by the chosen documented transport.
- `README.md` — document the direct-URL command and prerequisites without changing the existing playlist workflow.
- `docs/features/single-url-audiogram-plugin.md` — maintain DESIGN diagrams and boundaries; reconcile after implementation.

## Interfaces

### URL core

```js
parseYouTubeVideoUrl(input)
// { videoId, sourceUrl } or a stable coded validation error

validateYouTubeMetadata(metadata, requestedVideoId)
// { videoId, title, sourceUrl } or a stable metadata/identity error
```

Accept standard `youtube.com/watch?v=...`, `youtu.be/...`, and YouTube `/shorts/`, `/embed/`, or `/live/` paths on `youtube.com`, `www.youtube.com`, `m.youtube.com`, and `youtu.be`. Ignore playlist parameters; fetch metadata for the single normalized video only. Reject other hosts, malformed URLs, and invalid video IDs.

### Pipeline command

```js
runSingleUrlPipeline({ url, projectRoot, environment, dependencies })
// { contractVersion: 1, status: "complete" | "no_clips" | "failed",
//   source: { videoId, title, url } | null, artifactPaths: string[], error? }
```

`node scripts/audiogram-url.mjs --url <youtube-url>` emits one JSON contract on stdout for every valid invocation, including failed processing and no-clips outcomes; diagnostics go to stderr. Argument/usage errors emit no JSON and exit `2`. Structured terminal outcomes exit `0`, leaving status interpretation to the caller. The command must not create a Google OAuth client or call playlist APIs. Existing local ledger/idempotency and Remotion paths remain authoritative. The runner adapter accepts the same versioned request/result shape that a future Cloud Run Job dispatcher can implement; only the adapter and artifact store may change for cloud deployment.

### MCP HTTP tools and job lifecycle

- `create_audiogram({ url })` validates the URL, starts local processing, and returns a versioned result with an opaque `jobId` and current status; it does not imply success before artifacts exist.
- `get_audiogram_status({ jobId })` returns `queued`, `running`, `complete`, `no_clips`, or `failed`, with verified project-relative artifact paths only after completion.
- Keep job identity/status behind a runner interface. Local implementation uses a small SQLite job record plus a detached worker that invokes the stable CLI; do not make MCP handlers import pipeline internals. The worker records `running` and terminal states so a service restart does not fabricate or lose completion status. The local job store is replaceable by managed job metadata in the future cloud adapter.
- The HTTP service listens only on `127.0.0.1`; `/mcp` uses Streamable HTTP. The README instructs the developer to expose it to ChatGPT only through the OpenAI Secure MCP Tunnel and to configure the tunnel in Developer Mode. Tunnel setup is user/account configuration and is not automated by project code.
- Verify each completed artifact is a non-empty MP4 under `out/treatments/`. Never give a local filesystem path the semantics of a public download URL.

### Cloud Run compatibility boundary (future; not implemented here)

Keep tool names, request/result schema, and runner interface transport-neutral. A future deployment may host `/mcp` on a Cloud Run service, dispatch render work to a Cloud Run Job, persist job metadata in managed storage, and place MP4s in Cloud Storage behind expiring download links. Local mode must not require Google Cloud SDKs, credentials, network access to Google Cloud, or cloud-only config. Cloud adaptation is a separate reviewed feature; the local implementation must not claim cloud readiness beyond this explicit seam.

---

### Task 1: YouTube URL validation core

**Files:** Create `scripts/youtube-url-core.mjs` and `scripts/youtube-url-core.test.mjs`.

**Interfaces:** Provides the URL functions above using Node's `URL`; no dependency.

- [x] Write tests for watch, short, shorts, embed, and live forms; invalid host/path, malformed URL, missing ID, and ignored playlist parameters.
- [x] Run `node --test scripts/youtube-url-core.test.mjs`; observed the expected missing-module failure before implementation.
- [x] Implement normalization and coded errors, including metadata ID mismatch and unusable metadata.
- [x] Run the focused tests; all URL classes pass (5/5).
- [x] Commit URL core and tests (`9f33cc4`).

### Task 2: Direct-URL Audiograms pipeline and command

**Files:** Create `scripts/single-url-pipeline.mjs`, its tests, `scripts/audiogram-url.mjs`, its tests; modify `package.json` and `README.md`.

**Consumes:** URL core. **Produces:** `runSingleUrlPipeline` and the version-1 CLI contract.

- [x] Write injected-dependency tests asserting one video is submitted to the ledger, playlist OAuth is bypassed, selection/render is scoped to that video, local approval queue behavior is retained, and only renderer-confirmed artifacts are returned.
- [x] Run the focused tests and confirm the missing runner causes the expected failure.
- [x] Implement pipeline orchestration by reusing the existing selection, ledger, package, asset, and treatment modules; validate metadata identity before creating ledger work; surface no-clips and partial-render failure distinctly.
- [x] Write CLI tests for missing URL, unsupported flag, JSON stdout purity, result/exit status, and stderr diagnostics.
- [x] Implement the Node `parseArgs` wrapper and npm alias `audiogram:url`; document prerequisites, URL-only semantics, JSON result contract, and exit behavior in the root README.
- [x] Run `node --test scripts/youtube-url-core.test.mjs scripts/single-url-pipeline.test.mjs scripts/audiogram-url.test.mjs` (15/15 pass).
- [x] Commit pipeline, command, tests, package metadata, and guidance (commit recorded in worktree history).

### Task 3: Local Streamable HTTP MCP service and runner interface

**Files:** Create the `plugins/audiogram-helper/` service, runner, worker, job-store, result-validation modules and tests/README; modify package metadata for the current SDK and local scripts.

**Consumes:** Version-1 CLI result contract. **Produces:** loopback-only `/mcp`, `create_audiogram`, `get_audiogram_status`, and a local runner adapter implementing the shared job/status interface.

- [x] Write tests first for tool discovery, URL rejection, job start/status transitions, child-process error/nonzero exit, malformed result JSON, restart/failure honesty, and invalid/missing/empty/out-of-root artifacts.
- [x] Run `node --test plugins/audiogram-helper/server.test.mjs`; confirmed expected missing-module failure before implementation.
- [x] Implement the documented Streamable HTTP transport on loopback only, with request-size/host-origin checks and orderly shutdown. Keep server handlers independent of Audiograms internals through the runner adapter.
- [x] Implement the local runner using argument-array process invocation (`shell: false`) and a local SQLite job record; persist no OpenAI tunnel secrets. Return opaque job IDs and truthful states; the detached worker runs the CLI, validates its JSON result, and commits terminal state.
- [x] Add README startup and manual Developer Mode/Secure MCP Tunnel steps, including loopback binding and the tunnel's development-only boundary.
- [x] Do not add a public-distribution manifest or claim directory readiness; public packaging/submission remains separate.
- [x] Run MCP tests and local protocol handshake/tool discovery without fetching/rendering a live video; verify binding to `127.0.0.1`.
- [x] Commit service, tests, README, and dependency metadata (commit pending).

### Task 4: Design reconciliation and complete local verification

**Files:** Modify `docs/features/single-url-audiogram-plugin.md`; correct implementation/README metadata only if tests require it.

- [x] Compare actual request, job lifecycle, persistence, approval, artifact, and failure behavior against the feature note; document deviations explicitly.
- [x] Set feature-note metadata to `status: COMPLETE`, `design-reviewed: true`, and `implementation-reconciled: true` after comparison.
- [x] Run `npm run test:youtube`, `npm run lint`, and `npm run verify:feature-docs`; full test suite reports 228 pass and one previously reproduced unrelated OAuth smoke failure.
- [x] Run a local MCP handshake and discover both tools. No public tunnel, publishing, or live video processing was initiated; manual connection steps are in the plugin README.
- [x] Inspect and commit only feature-specific files in this isolated branch (commit pending).

## Plan self-review

- Spec coverage: URL-only scope, existing selection defaults, local ledger/render/output, no external publishing, stable contract, and future evolution seam are covered. This plan adds asynchronous job/status tools because video rendering can outlive a single conversational tool request and the same job interface maps cleanly to a future Cloud Run Job dispatcher.
- Tunnel scope: project code does not create an account tunnel, retain its credentials, or expose a public listener; the user completes OpenAI Developer Mode connection following the README.
- Cloud scope: no cloud resources or production endpoint are created; Cloud Run/Cloud Storage are a later runner/artifact adapter, not a dependency of local mode.
- Execution scope: the user reviewed the plan and authorized inline implementation in the isolated worktree.
