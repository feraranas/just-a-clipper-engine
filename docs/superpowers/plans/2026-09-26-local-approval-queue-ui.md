# Local Approval Queue UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, with bounded review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free local browser page that previews queued MP4 artifacts, edits captions, and requires explicit per-item approval or rejection before future publishing.

**Architecture:** Reuse `scripts/publishing-server.mjs` and `scripts/publishing-ledger.mjs` as the stateful boundary. Add a static HTML/CSS/JavaScript client under `public/publishing/`; the browser reads server state, sends existing mutation requests, then reloads the item rather than inventing state. Instagram publishing remains outside this slice.

**Tech Stack:** Node.js built-in HTTP server, SQLite ledger, browser-native HTML/CSS/JavaScript, Node test runner, existing npm scripts.

**Spec:** `docs/features/local-approval-queue-ui.md`

## Global Constraints

- Keep the first version local and dependency-free.
- Do not add Instagram credentials, authentication, automatic publishing, or a frontend framework.
- Approval must remain an explicit user action; queue visibility must never imply approval.
- Approved artifact hashes remain bound to the reviewed artifact.
- Preview paths remain project-relative MP4 paths validated by the server.
- Browser code must not receive or persist Instagram credentials.
- Preserve the existing ledger transition rules and failure diagnostics.

## Review Focus

- Empty queue and malformed API payloads must render a useful empty/error state rather than a blank page; test the client response-normalization helper.
- A preview path must be generated from the item ID, not from an unsanitized artifact path; test the preview URL builder and server route.
- Caption saves, approvals, and rejections must not optimistically finalize UI state when the API fails; test mutation error handling.
- Approval must require a valid schedule timestamp and rejection must require a non-empty reason; rely on and extend server contract tests.
- A stale item state must produce a visible transition error and trigger a refresh path rather than silently overwriting the ledger; test the client mutation flow.

### Task 1: Define the browser/client contract with pure helpers

**Files:**
- Create: `public/publishing/app.mjs`
- Create: `public/publishing/app.test.mjs`

**Interfaces:**
- `buildPreviewUrl(itemId)` returns `/api/items/<encoded-id>/preview`.
- `normalizeQueuePayload(payload)` returns an array of publishing items or throws a user-safe payload error.
- `formatItemMetadata(item)` returns display-ready metadata without changing state.
- `mutationRequest(fetchImpl, path, body)` returns the parsed `{item}` response or throws a user-safe API error.

- [ ] **Step 1: Write the failing tests**

  Add Node tests for:

  ```js
  test("encodes item IDs when building preview URLs", () => {
    assert.equal(buildPreviewUrl("item/one"), "/api/items/item%2Fone/preview");
  });

  test("normalizes a valid queue payload and rejects malformed payloads", () => {
    assert.deepEqual(normalizeQueuePayload({ items: [{ id: "one" }] }), [{ id: "one" }]);
    assert.throws(() => normalizeQueuePayload({ items: "not-an-array" }), /queue payload/i);
  });

  test("surfaces API error bodies without claiming success", async () => {
    await assert.rejects(
      mutationRequest(async () => new Response(JSON.stringify({ error: "stale state" }), { status: 409 }), "/api/items/one/approve", {}),
      /stale state/,
    );
  });
  ```

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test public/publishing/app.test.mjs`

  Expected: FAIL because `public/publishing/app.mjs` does not exist yet.

- [ ] **Step 3: Implement the minimal pure helpers**

  Export the three display/request helpers from `app.mjs`. Keep DOM access out of these helpers so they remain testable in Node. `mutationRequest` must check `response.ok`, parse JSON, and prefer a server-provided `error` message.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test public/publishing/app.test.mjs`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add public/publishing/app.mjs public/publishing/app.test.mjs
  git commit -m "test: define approval queue client contract"
  ```

### Task 2: Add the static approval queue page and interactions

**Files:**
- Create: `public/publishing/index.html`
- Create: `public/publishing/styles.css`
- Modify: `public/publishing/app.mjs`
- Modify: `public/publishing/app.test.mjs`

**Interfaces:**
- `loadQueue(fetchImpl)` fetches `GET /api/items` and returns normalized items.
- `saveCaption(fetchImpl, itemId, caption)` posts to `/api/items/:id/caption`.
- `approveItem(fetchImpl, itemId, scheduledAt)` posts to `/api/items/:id/approve`.
- `rejectItem(fetchImpl, itemId, reason)` posts to `/api/items/:id/reject`.
- Browser initialization binds these operations to rendered queue cards.

- [ ] **Step 1: Write the failing interaction/markup tests**

  Extend the client contract tests with request-shape assertions:

  ```js
  test("approval sends an ISO schedule to the existing approve route", async () => {
    const calls = [];
    await approveItem(async (url, options) => {
      calls.push([url, options]);
      return Response.json({ item: { id: "one", state: "approved" } });
    }, "one", "2026-09-27T12:00:00.000Z");
    assert.equal(calls[0][0], "/api/items/one/approve");
    assert.deepEqual(JSON.parse(calls[0][1].body), { scheduledAt: "2026-09-27T12:00:00.000Z" });
  });

  test("rejection sends the required reason", async () => {
    const calls = [];
    await rejectItem(async (url, options) => {
      calls.push([url, options]);
      return Response.json({ item: { id: "one", state: "rejected" } });
    }, "one", "Not suitable for this account");
    assert.deepEqual(JSON.parse(calls[0][1].body), { reason: "Not suitable for this account" });
  });
  ```

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test public/publishing/app.test.mjs`

  Expected: FAIL because the mutation helpers and page markup do not exist.

- [ ] **Step 3: Implement the page and client behavior**

  Build a semantic page with:

  - a queue region and refresh control;
  - one card per candidate with title, state, hash, timestamps, and source metadata;
  - `<video controls preload="metadata">` using `buildPreviewUrl(item.id)`;
  - caption textarea and save button;
  - schedule datetime input and approve button;
  - rejection reason input and reject button;
  - inline loading, empty, success, and error messages.

  Disable actions while their request is pending. After every successful mutation, reload the queue from the server. Do not use optimistic state transitions.

- [ ] **Step 4: Run the focused tests and inspect the page locally**

  Run: `node --test public/publishing/app.test.mjs`

  Start the server with: `node scripts/publishing-server.mjs`

  Open: `http://127.0.0.1:8787/`

  Expected: the page loads, renders an empty state when no records exist, and shows API errors in the page rather than only the console.

- [ ] **Step 5: Commit**

  ```bash
  git add public/publishing/index.html public/publishing/styles.css public/publishing/app.mjs public/publishing/app.test.mjs
  git commit -m "feat: add local publishing approval queue UI"
  ```

### Task 3: Harden the server/UI contract and verify the feature documentation

**Files:**
- Modify: `scripts/publishing-server.test.mjs`
- Modify: `scripts/publishing-server.mjs` only if a contract test identifies a required response/header fix
- Modify: `docs/features/local-approval-queue-ui.md`

**Interfaces:**
- Existing API routes remain `/api/items`, `/api/items/:id/preview`, `/caption`, `/approve`, and `/reject`.
- Static files remain served from `public/publishing`.

- [ ] **Step 1: Add contract coverage for UI-facing server behavior**

  Pin that `GET /api/items` returns `{ items: [...] }`, preview responses are `video/mp4`, mutation responses return `{ item }`, invalid approval/rejection requests return non-2xx JSON errors, and traversal attempts cannot read outside the project root.

- [ ] **Step 2: Run the server tests before changing implementation**

  Run: `node --test scripts/publishing-server.test.mjs`

  Expected: existing tests pass; any missing contract is identified by the new assertions.

- [ ] **Step 3: Make only the minimal server changes required by the tests**

  Preserve the ledger’s state machine and error messages. Do not add authentication, Instagram calls, or bulk actions.

- [ ] **Step 4: Run the full safe verification**

  Run: `npm run lint`

  Run: `for test_file in scripts/*.test.mjs; do case "$test_file" in scripts/publishing-server.test.mjs|scripts/clip-selector-smoke.test.mjs) continue;; esac; node --test "$test_file" || exit 1; done`

  Run: `node --test scripts/publishing-server.test.mjs public/publishing/app.test.mjs`

- [ ] **Step 5: Reconcile the feature document**

  Compare the implementation and tests with the design. Record any intentional deviations under “Implementation reconciliation and deviations”, then set:

  ```yaml
  status: COMPLETE
  design-reviewed: true
  implementation-reconciled: true
  ```

  Run: `npm run verify:feature-docs` if that repository verifier exists; otherwise record that the verifier is not yet available and manually check the required sections.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/publishing-server.test.mjs scripts/publishing-server.mjs docs/features/local-approval-queue-ui.md
  git commit -m "test: verify local approval queue boundaries"
  ```

## Plan self-review

- Spec coverage: purpose, UI scope, approval boundary, state lifecycle, error paths, invariants, proposed files, and unchanged Instagram behavior are covered by Tasks 1–3.
- Placeholder scan: no TODO/TBD implementation steps are used; each task has concrete files, interfaces, tests, commands, and commits.
- Type consistency: browser helpers use `fetchImpl`, item IDs are encoded in URLs, and mutation helpers return the server’s `{ item }` response.
- Review focus coverage: malformed payloads and API errors are in Task 1; request shape and no-optimism behavior are in Task 2; server transitions and traversal are in Task 3.
