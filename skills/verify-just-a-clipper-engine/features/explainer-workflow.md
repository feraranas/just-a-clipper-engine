# Candidate review and explanation-video workflow (experimental)

Turns an explicitly selected topic from a YouTube video into an animated explanation video, with human approval gates. A completed, verified render may be registered in the local [approval queue](./approval-ui.md); queue insertion never approves, schedules or publishes. Surfaces: CLIs `npm run candidates:review` and `npm run explainer`, the MCP tools `prepare_candidate_review`, `retry_candidate_review`, `get_candidate_review`, `select_candidate_review`, `list_scene_blocks`, `continue_explainer` ([mcp-helper](./mcp-helper.md)), and the Remotion compositions `AnimatedExplainer`, `LiamLikeness20`, `LiamOriginalStatic`, `LiamOriginalTalking`, `LiamLipSyncCloseup`, `PresenterStatic`, `PresenterTalking`.

## Sub-features

- `cand-prepare` `candidates:review --url URL` runs transcript extraction + the LLM selector + Jev to save a review in `$AUDIOGRAM_DATA_ROOT/candidate-reviews.sqlite`. Needs LLM and Jev config (paid/OAuth): not driven.
- `cand-retry` `candidates:review --retry-review ORIGINAL_ID --review-id NEW_UUID` (MCP: `retry_candidate_review`) retries a timed-out drafting attempt from its saved transcript. Requires an explicit new id; may incur LLM and Jev cost; never auto-retries. Not driven live.
- `cand-get` / `cand-select` read a saved review and select a candidate with `--review ID --hash REVIEW_HASH --select candidate-N`. Need an existing review.
- `exp-steps` `explainer --action get|research|script|draft|approve_script|narrate|import_audio|accept_audio|scenes|plan|render|queue_render|recover_render|recover_draft --review ID --revision N [--input FILE] [--hash H]`. Every mutation needs the current revision and the previous approvals (script hash, audio SHA-256). `narrate` spends ElevenLabs credits; `draft`/`plan` use the LLM; `render` needs local presenter artwork (`AUDIOGRAM_PRESENTER_ASSETS`, not in git) and Rhubarb.
- `exp-narration-preflight` MCP `continue_explainer` with `action: "narrate"` rejects an unapproved (or stale) script before launching a worker, with the fixed message `Approve the exact current script before starting narration.` No request file is created and no paid call starts. The worker still rechecks approval before calling the provider.
- `exp-recover-draft` `recover_draft` clears only an unconfirmed `drafting_script` attempt, using the current revision and pending token. It does not call a provider or alter research. A stale token or revision fails closed (`Recovery attempt is stale` on the CLI; MCP wraps other failures in a generic message).
- `exp-queue` After a verified render is persisted, the runner registers the MP4 in the durable artifact store and enqueues it for the configured account (empty caption). `queue_render` reconciles the current revision without re-rendering. Registration failure leaves the render intact and asks the operator to retry with `queue_render`. Dedupe is by artifact identity; an existing approval is not overwritten. Never drive this against a real ledger with credentials.
- `exp-scene-blocks` MCP `list_scene_blocks({})` → `comparison` (2 items), `process` (2–5), `branch` (4), all `version: 1`.
- `exp-compositions` `npx remotion compositions src/index.ts` lists the seven presenter/explainer compositions above next to `AudiogramBasic`.
- `exp-plugin-listing` The MCP `list_video_templates` catalog includes `Animated Explainer V1` (`animated-explainer` / `1` / `default`, `workflow: "explainer"`). That selection must start with `prepare_candidate_review`, not `create_audiogram`. The Classic CLI catalog still rejects the explainer identity.

## How to get to it (user POV)

- README section "Selected topic to an explanation video (experimental)"; or ChatGPT through the MCP helper (`list_video_templates` → Animated Explainer → `prepare_candidate_review` / `continue_explainer`).

## Driving it with clipctl

Preconditions:

- Node >= 22.13; `AUDIOGRAM_DATA_ROOT=$STATE/data`; no LLM/Jev/ElevenLabs credentials.

- **Guards (CLI).** `node scripts/explainer/run.mjs --action get --review <uuid>` → stderr `{"error":"Select a candidate before video production"}`, exit 1; `--action research` without `--revision` → `{"error":"Supply review identity and current revision"}`, exit 1; `--action recover_draft` or `--action queue_render` with only a review uuid → the same missing-revision error. `node scripts/candidate-review-run.mjs` (no args, bad or unknown input, no provider) → `Candidate review failed. Check provider configuration and saved progress; no video was rendered.`, exit 1. The same generic failure is printed for `--retry-review` without `--review-id`, and for `--retry-review` / `--review-id` with unknown ids and no provider.
- **MCP.** Start the helper as in [mcp-helper](./mcp-helper.md); `mcp-modern.mjs URL` lists ten tools including `retry_candidate_review`. `list_video_templates` includes `templateId: "animated-explainer"`. `list_scene_blocks({})` prints the three blocks. `get_candidate_review` / `continue_explainer {action:"get"|"recover_draft"|"queue_render"|"narrate"}` with an unknown UUID, `retry_candidate_review` with two unknown UUIDs, and `prepare_candidate_review` with `https://example.com/x` return `isError` with a generic message. `create_audiogram` with `templateId: "animated-explainer"` is rejected (`Unknown template selection. Available: classic / 1 / default.`).
- **Compositions.** `npx remotion compositions src/index.ts --browser-executable=$CHROME_PATH` lists them.
- **Unit tests.** `npm run test:explainer` and `npm run test:candidate-review` use fakes (developer signal only). They are the coverage for the exact narration-preflight message, draft-source constraints, retry-from-transcript, and queue registration edges.

## Gotchas

- Without a saved candidate review no later step can be driven live. Seeding the review database directly is not a user path, so the research → render chain, narration, scene planning, presenter renders, `recover_draft`, `queue_render` against a real artifact, and a live `--retry-review` stay unverified here.
- The exact MCP narration-preflight wording needs a saved review whose current script is unapproved; that path is covered by unit tests, not by a live drive.
- The presenter artwork is personal and not in git; an `AnimatedExplainer` render fails or is blank without it.
- Queue insertion uses the publishing ledger under `AUDIOGRAM_DATA_ROOT`. Use a scratch data root; never run it against the real Audiogram Inbox ledger.
