# Playable Template Previews and ChatGPT UI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, task by task. No subagents. Preserve unrelated work. This document is a plan, not a claim that the UI exists.

**Goal:** Let a person discover templates, open a playable public sample, and play the same sample inside ChatGPT.

**Architecture:** Reuse the existing catalog, sample registry and page server. Enrich the MCP listing with public preview metadata and text links. Register a bundled MCP Apps component for that same tool. A separately approved video host delivers the MP4 directly to browsers.

**Tech Stack:** Existing Node/MCP SDK/Zod; standard MCP Apps extension SDK; a small vanilla TypeScript UI bundled with esbuild; native HTML video. Proposed host: Cloudflare Stream generated MP4.

**Spec:** `docs/features/template-preview-chatgpt.md`

## Global constraints

- Inline execution, no subagents; do not modify unrelated explainer/recovery work.
- Preserve contractVersion 1 and existing fields; preview is an optional additive field.
- Match previews by templateId, templateVersion and variationId.
- No rendering, job creation, provider calls or HTTP probes during a listing request.
- Keep public sample assets outside Git checkouts.
- No MP4 serving through the local public Tunnel route.
- No purchase/upload until the exact provider setup has approval.
- No COMPLETE claim before actual ChatGPT playback and listening acceptance.

## Review focus

- A missing sample store must not remove the template catalog (Task 1).
- A preview must never be assigned to a different variation (Task 1).
- A blocked video must leave the external link usable (Tasks 3 and 5).
- A stale cached UI must not misread newer tool data (Tasks 2 and 3).
- Opening the card must not create a job (Tasks 2, 3 and 5).

## File map

| File | Responsibility |
| --- | --- |
| `plugins/audiogram-helper/template-previews.mjs` (new) | Public preview projection from the validated sample registry |
| `plugins/audiogram-helper/template-previews.test.mjs` (new) | Identity, URL, failure and disclosure tests |
| `plugins/audiogram-helper/template-listing.mjs` | Optional per-variation preview schema and enrichment |
| `plugins/audiogram-helper/template-listing.test.mjs` | Existing contract and enriched listing compatibility |
| `plugins/audiogram-helper/server.mjs` | Read snapshot, produce links, register optional UI |
| `plugins/audiogram-helper/server.test.mjs` | Real MCP transport tests |
| `plugins/audiogram-helper/template-ui-resource.mjs` (new) | UI URI, bundled HTML, MIME and CSP registration |
| `plugins/audiogram-helper/ui/template-preview.ts` (new) | Bridge integration and media/error handling |
| `plugins/audiogram-helper/ui/template-preview.css` (new) | Responsive cards and accessible focus styles |
| `plugins/audiogram-helper/ui/template-preview-model.mjs` (new) | Validate and normalize received public data |
| `plugins/audiogram-helper/ui/template-preview-model.test.mjs` (new) | Data/error states without a browser |
| `scripts/build-template-ui.mjs` (new) | Produce a self-contained UI resource |
| `scripts/verify-template-preview.mjs` (new) | Explicit bounded public diagnostics, never called by listing |
| `scripts/verify-template-preview.test.mjs` (new) | Controlled HTTP fixtures for diagnostics |
| `package.json`, `package-lock.json`, `.gitignore` | Exact compatible dependencies, build/test commands, ignored UI output |
| `.env.example`, `plugins/audiogram-helper/README.md` | Configuration, setup and rollback instructions |
| `docs/features/template-preview-chatgpt.md` | Design and verified implementation evidence |

## Task 1: Clickable preview links and shared public data

**Interfaces:**

```ts
type Selection = { templateId: string; templateVersion: string; variationId: string };
type Preview = { status: 'poster-only' | 'video-configured'; pageUrl: string; posterUrl: string; videoUrl?: string };
// template-previews.mjs
previewKey(selection: Selection): string; // JSON.stringify of ordered identity tuple
loadTemplatePreviews({ sampleRoot, publicOrigin, videoOrigin }): Promise<Map<string, Preview>>;
// template-listing.mjs, retain existing first argument and default
buildTemplateListing(entries?, previews = new Map()): TemplateListing;
```

- [ ] Add failing tests for a valid Classic preview and a second synthetic variation with no sample. Assert only the exact variation is enriched.

```js
const listing = buildTemplateListing(catalog, new Map([
  [previewKey({templateId:'classic',templateVersion:'1',variationId:'default'}), preview]
]));
assert.equal(listing.templates[0].variations[0].preview.pageUrl, preview.pageUrl);
assert.equal(listing.contractVersion, 1);
```

- [ ] Run `node --test plugins/audiogram-helper/template-previews.test.mjs plugins/audiogram-helper/template-listing.test.mjs`. Expected: missing module/interface failures before implementation.
- [ ] Implement projection using `loadSampleRegistry`. Add `AUDIOGRAM_SAMPLE_PUBLIC_ORIGIN=https://samples.ferarana.work` and optional `AUDIOGRAM_SAMPLE_VIDEO_ORIGIN` configuration. Require public HTTPS origins without credentials/path/query/fragment. Only the configured video origin can appear in videoUrl. Missing public origin returns an empty preview map. Invalid startup configuration produces a clear operator error.
- [ ] Catch missing/invalid registry as unavailable previews, returning the valid catalog. Do not catch catalog validation as a sample failure. Hash-derived poster URL is built from the validated entry. Export only the Preview fields, never spread the internal entry.
- [ ] Add optional Preview schema to variations. Use existing names templateId/templateVersion, not new id/version aliases. Preserve defaultSelection.
- [ ] Include `Preview: <pageUrl>` in text output for each preview. Inject preview loader into the server for transport tests; read one snapshot per call.
- [ ] Test missing files, bad poster hashes, invalid HTTPS URLs, credentials, duplicate identities, no video, and no local paths in serialized output. Assert runner.start is never called.
- [ ] Run the focused tests plus `node --test plugins/audiogram-helper/server.test.mjs`. Expected: all pass, old no-preview listing assertions unchanged.
- [ ] Commit this complete slice. The clickable poster-only link is useful immediately while hosting work continues.

## Task 2: Register the MCP UI resource

**Interfaces:**

```js
export const TEMPLATE_UI_URI = 'ui://video-templates/v1.html';
// template-ui-resource.mjs
export function registerTemplateUi(server, {html, sampleOrigin, videoOrigin}) { /* register resource */ }
```

- [ ] Inspect installed SDK compatibility; choose and pin a compatible `@modelcontextprotocol/ext-apps` version and esbuild. Do not upgrade the existing MCP SDK blindly. Record versions in package-lock.json.
- [ ] Write transport tests asserting resource discovery/read, correct MIME, metadata and no effect on create/get/retry tools. Initially expect no resource/metadata.
- [ ] Register resource through standard SDK helpers. Contents use `RESOURCE_MIME_TYPE` and `_meta.ui.csp` with exact sample and video origins. No wildcard or nested frame permissions.

```js
registerAppResource(server, 'video-templates', TEMPLATE_UI_URI, {}, async () => ({
  contents: [{uri:TEMPLATE_UI_URI, mimeType:RESOURCE_MIME_TYPE, text:html,
    _meta:{ui:{csp:{resourceDomains:allowedOrigins, connectDomains:[]}}}}]
}));
// On the list_video_templates descriptor:
_meta: {ui:{resourceUri:TEMPLATE_UI_URI}}
```

- [ ] Add `AUDIOGRAM_TEMPLATE_UI_ENABLED=false` default. With it false, preserve ordinary tool registration and links. With it true, load the built bundle before advertising the UI; missing bundle is a startup error. Keep authentication and existing MCP transport unchanged.
- [ ] Test enabled/disabled paths and exact CSP origins. Register only on list_video_templates. Check tools/list, resources/list, resources/read and tools/call with the existing test Client.
- [ ] Run `npm run test:audiogram-plugin`. Expected: all tests pass.
- [ ] Commit the resource registration slice.

## Task 3: Build the interactive preview component

**Interfaces:** `template-preview-model.mjs` exports `parseTemplatePreviewResult(value)` returning validated templates or a typed error. `template-preview.ts` receives MCP tool results, passes structuredContent to the parser, then renders the cards. No backend mutation interface is exposed.

- [ ] Write model tests for absent/malformed results, empty catalogs, multiple variations, malicious text/URLs, poster-only and configured video. Expect missing parser failure before implementation.
- [ ] Build a small DOM-based component with the MCP Apps App bridge. Install the result handler before connecting. Confirm installed SDK callback and handshake signatures from its types and current docs; use the SDK instead of custom postMessage parsing.

```js
const app = new App({name:'Video templates', version:'1.0.0'});
app.ontoolresult = result => render(parseTemplatePreviewResult(result.structuredContent));
await app.connect();
```

- [ ] Render text with textContent, validated URLs as attributes, and one card per variation. Show exact selection values. Add native video with controls, playsinline and preload=none. Keep Open preview visible in every state with a page URL. Use the SDK openLink action for external navigation.
- [ ] Handle video errors, missing previews and tool errors explicitly. Pause the previous video when another starts or the tool result changes. Never autoplay or invoke create_audiogram from the component.
- [ ] Build with esbuild into ignored `plugins/audiogram-helper/ui/dist/template-preview.html`, with script/style bundled inline. Add `npm run build:template-ui`; build must not depend on a running sample server. Include the build in release preparation and checks.
- [ ] Create a temporary local host harness that delivers controlled tool results via the bridge. Check keyboard access, narrow viewport, multiple results, missing media and denied external navigation. Assert no outbound job calls.
- [ ] Run model tests, UI build and MCP tests. Expected: all pass; browser visibly shows working states. Change the resource URI version on breaking UI contract changes.
- [ ] Commit UI and build documentation.

## Task 4: Make the neutral sample playable publicly

**Delivery choice:** propose Cloudflare Stream, using its generated MP4 URL with our native player. Keep all code provider-independent beyond the configured origin.

- [ ] Confirm PR #39 status, the current registered local file/hash, and listening review. Show the neutral file to the user before accepting it as the public demo.
- [ ] Present the exact Cloudflare account, current Stream cost, intended upload and public-access scope. Obtain approval before enabling a paid service or uploading. This step can run after Tasks 1–3; it does not block their implementation.
- [ ] Upload the one reviewed MP4 using the approved account workflow. Record provider video ID and local video hash outside the repository. If the result is ambiguous, inspect the account before retrying.
- [ ] Wait for video readiness, enable generated MP4 output, then wait for download status ready. Use the returned URL instead of inventing a provider URL. See the linked Stream documentation.
- [ ] Add failing tests for `verify-template-preview.mjs` using controlled endpoints: valid MP4 response, rejected HEAD, failed Range, HTML error body and off-origin redirect. The verifier accepts only explicit operator-approved page/video origins, caps time and bytes, and is never invoked from tool requests.
- [ ] Implement explicit diagnostics: HEAD content type, Range bytes=0-1023 with 206/Content-Range, response redirect origin, and public page/poster status. Report each check separately; do not equate headers with browser playback.
- [ ] Atomically add videoUrl only to the matching registry entry under the existing writer lock. Preserve other samples and hashes. Set AUDIOGRAM_SAMPLE_VIDEO_ORIGIN to the returned origin. Restart the sample server and check that the page uses the new URL.
- [ ] Compare the hosted/transcoded content visually and by duration. Do not require its byte hash to equal the source MP4 after provider encoding. Verify play, pause, seek, audio and poster correspondence in a real browser.
- [ ] Record evidence. If hosting is unavailable or unapproved, leave this task explicitly incomplete and continue all local work.

## Task 5: Real ChatGPT rollout, fallback and reconciliation

- [ ] Run `npm run build:template-ui`, `npm run test:audiogram-plugin`, all new focused tests, existing sample-server tests, `npm run lint`, and `npm run verify:feature-docs`. Expected: pass before rollout.
- [ ] Restart the existing MCP service with verified origins and AUDIOGRAM_TEMPLATE_UI_ENABLED=true. Preserve its existing endpoint, authentication and plugin identity. Have the user refresh the connected tools.
- [ ] Ask for available templates in a fresh ChatGPT conversation. Confirm the actual list_video_templates call returns preview fields and text links, then verify that ChatGPT renders the registered resource.
- [ ] Play the sample inside ChatGPT. Check audio, seek, sizing, CSP failures and Open preview. A direct browser success alone does not satisfy this step.
- [ ] Test UI-disabled fallback: tools still list templates and provide a clickable preview URL. Restore the enabled state after checking.
- [ ] Confirm listing/opening/playing creates zero jobs. Verify create_audiogram still validates selection through the catalog without launching a live render just for this regression test.
- [ ] If client-signature filtering blocks the real host, inspect Cloudflare events with the user. Resolve only the specific compatibility issue with an approved scoped configuration change; do not weaken global security automatically.
- [ ] Reconcile this feature note and the sample-server note against actual evidence. Record the public page test, hosting identity, bundle version and real ChatGPT playback. Mark only genuinely completed scopes COMPLETE.
- [ ] Keep the implementation PR draft while any host/playback gate remains unverified. PR body: `Feature-docs: docs/features/template-preview-chatgpt.md, docs/features/template-sample-server.md` when both behaviors are modified. Preserve unrelated notes.

## Acceptance and rollback

Done means: clickable link works; the same neutral video plays on the public
page and inside ChatGPT; exact variation data remains available to the model;
viewing creates no job; unsupported hosts retain text links; tests and real-host
evidence are recorded. Service availability still depends on the Mac and its
existing processes. Always-on process supervision is a separate operational task.

Rollback: disable AUDIOGRAM_TEMPLATE_UI_ENABLED and restart MCP to retain links.
If video delivery fails, remove only videoUrl under the registry writer lock and
restart the sample server; the poster remains. Never delete user media or provider
assets as part of an automatic rollback.

## Review and execution status

Plan only. Design review pending. No dependencies installed, provider configured,
upload performed, or new tool behavior deployed by writing this plan. Task order
allows links and UI development before the hosting approval. Revalidate current
PR/branch state before implementation; do not assume PR #39 has merged.

## References

- https://developers.openai.com/plugins/build/chatgpt-ui
- https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/quickstart.md
- https://developers.cloudflare.com/stream/viewing-videos/download-videos/
- https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/
