# Template Sample Server Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Do not delegate. Read the design before implementing each task.

**Goal:** Serve an accurate Classic V1 demonstration page and poster from the user's Mac, with an optional external video URL.

**Architecture:** A small Node HTTP server validates a sample registry and durable poster assets. The page loads video directly from a configured external HTTPS host. A user-configured Cloudflare Tunnel later exposes only this server.

**Tech Stack:** Existing Node.js 22 runtime, built-in HTTP/filesystem APIs, existing template catalog and Remotion renderer, FFmpeg/ffprobe, local macOS narration.

**Spec:** `docs/features/template-sample-server.md`

## Global constraints

- Bind to `127.0.0.1:8790` by default; no automatic port fallback.
- Accepted assets remain outside source checkouts.
- No MP4 serving/proxying, jobs, providers, publishing, or dashboard mutation.
- Preserve unrelated animated-explainer work and all local user state.
- Keep design metadata honest; this plan does not authorize implementation.

## Review focus

- A changed or missing poster returns a safe response rather than arbitrary bytes.
- A malformed external video URL fails validation; HTML attributes are escaped.
- A busy port does not silently alter the Cloudflare target.
- An unavailable external host produces a readable playback error.
- A symlink or encoded traversal cannot expose files outside registered assets.

## File responsibilities

- Create `scripts/template-sample-registry.mjs`: identity/config validation and verified poster resolution.
- Create `scripts/template-sample-server.mjs`: loopback HTTP routing, startup, shutdown, and safe errors.
- Create `scripts/template-sample-page.mjs`: escaped HTML and player states.
- Create corresponding `scripts/*.test.mjs` tests.
- Create `scripts/render-template-sample.mjs`: explicit reproducible neutral fixture rendering and asset promotion.
- Create `fixtures/template-samples/classic-v1/`: original script, image source, timing definition, and reproducibility notes; no credentials.
- Modify `package.json`: `samples:serve` and `samples:render` commands.
- Modify `.env.example` and helper README: sample configuration and operator handoff.
- Reconcile `docs/features/template-sample-server.md` after verification.

### Task 1: Registry and durable asset validation

- [x] Inspect existing storage config, artifact store, and template selector; reuse their conventions.
- [x] Write failing tests for valid identities, duplicate identities, missing/changed posters, invalid URLs, checkout roots, and symlink/traversal escapes.
- [x] Run focused registry tests and confirm intended failures.
- [x] Implement the registry schema, absolute root configuration, explicit asset hashes/revisions, and optional HTTPS URL validation.
- [x] Verify all tests, including another caller checkout using the same asset root.

### Task 2: Preview page and dedicated HTTP server

- [x] Write failing tests for GET/HEAD, 405, 404, correct content types, ETag behavior, escaped text/URLs, absent video, and player error UI.
- [x] Add tests proving MP4, queue, MCP, arbitrary paths, and encoded traversal are inaccessible.
- [x] Add a port-conflict test and missing/changed-asset request tests.
- [x] Implement the page with native controls, no autoplay, `playsinline`, narrow CSP, and an unavailable state.
- [x] Implement exact registered routes, loopback startup, explicit port validation, shutdown, and safe errors.
- [x] Run server/page/registry tests with ephemeral ports and temporary asset stores.
- [x] Add the start command and configuration documentation. Do not enable a background service.

### Task 3: Reproducible neutral Classic V1 sample

- [x] Read repository Remotion render guidance and inspect Classic composition props and current renderer interface.
- [x] Define original neutral demonstration content and imagery, marked as a sample; use local narration without provider fallback.
- [x] Write tests for sample identity, explicit generation, and failed asset promotion before implementing the render command.
- [x] Generate a 10–15 second sample using the actual Classic V1 renderer, then extract its poster.
- [ ] Verify video/audio properties and hashes; view frames and listen to narration. Fix clipping, timing, or pronunciation problems before acceptance.
- [x] Promote verified assets outside the checkout and register the poster. Keep video URL absent until hosting is selected.
- [x] Start locally in the foreground and visually inspect the poster-only preview page.

### Task 4: Verification, reconciliation, and PR handoff

- [x] Run focused tests and existing related storage/template regressions.
- [x] Run applicable lint/TypeScript checks and `npm run verify:feature-docs`.
- [x] Compare behavior against the design; document deviations and local evidence.
- [ ] Mark the feature COMPLETE only for verified local scope; explicitly record public rollout/video hosting/ChatGPT UI as pending separate work.
- [x] Prepare a reviewable implementation PR with `Feature-docs: docs/features/template-sample-server.md`.
- [x] Give the user the confirmed local address, foreground start/stop instructions, and exact dashboard fields.

## Operator rollout after local verification

- [ ] User enters subdomain `samples`, domain `ferarana.work`, empty Path, and Service URL `http://127.0.0.1:8790`; retain defaults and save the route.
- [ ] Verify HTTPS page, poster hashes, and forbidden-route responses without changing the queue or MCP service.
- [ ] Select an appropriate video host before any upload/subscription; configure its HTTPS URL and verify real browser playback.
- [ ] Plan background startup and the ChatGPT card separately after foreground checks.

## Execution status

Local server, registry, neutral render, tests, and operator docs are implemented.
Visual inspection and technical audio checks passed. Listening review remains
pending, so the implementation PR stays draft and the feature stays IN_PROGRESS.

Ruling: use word entries with proportional timings inside measured sentences.
Classic expects words for layout. Cost: word highlights can differ from speech.
Ruling: keep review inline under the user agent-cost policy. No subagents used.
Ruling: preserve the listening gate rather than mark an unperformed check complete.

Tasks 1–2: focused route/registry tests passed, including a new regression that
rejects roots inside another Git checkout. Initial tests failed before modules
existed. The macOS test root uses realpath to avoid the /var symlink alias.
Task 3: renderer-failure tests preserve the registry. The first narration was
9.91 seconds and correctly rejected. Rate 145 produced 11.093333 seconds.
Visual inspection caught and corrected sentence-entry clipping.
Task 4: inline review checked route isolation, URL escaping, hashes, failed
promotion, and port behavior. A regression caught nonnumeric rendered duration;
validation now rejects it. Full local media acceptance awaits listening.
