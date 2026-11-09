# Candidate review and explanation-video workflow (experimental)

Turns an explicitly selected topic from a YouTube video into an animated explanation video, with human approval gates. Never publishes or queues anything. Surfaces: CLIs `npm run candidates:review` and `npm run explainer`, the MCP tools `prepare_candidate_review`, `get_candidate_review`, `select_candidate_review`, `list_scene_blocks`, `continue_explainer` ([mcp-helper](./mcp-helper.md)), and the Remotion compositions `AnimatedExplainer`, `LiamLikeness20`, `LiamOriginalStatic`, `LiamOriginalTalking`, `LiamLipSyncCloseup`, `PresenterStatic`, `PresenterTalking`.

## Sub-features

- `cand-prepare` `candidates:review --url URL` runs transcript extraction + the LLM selector + Jev to save a review in `$AUDIOGRAM_DATA_ROOT/candidate-reviews.sqlite`. Needs LLM and Jev config (paid/OAuth): not driven.
- `cand-get` / `cand-select` read a saved review and select a candidate with `--review ID --hash REVIEW_HASH --select candidate-N`. Need an existing review.
- `exp-steps` `explainer --action get|research|script|draft|approve_script|narrate|import_audio|accept_audio|scenes|plan|render|recover_render --review ID --revision N [--input FILE] [--hash H]`. Every mutation needs the current revision and the previous approvals (script hash, audio SHA-256). `narrate` spends ElevenLabs credits; `draft`/`plan` use the LLM; `render` needs local presenter artwork (`AUDIOGRAM_PRESENTER_ASSETS`, not in git) and Rhubarb.
- `exp-scene-blocks` MCP `list_scene_blocks({})` → `comparison` (2 items), `process` (2–5), `branch` (4), all `version: 1`.
- `exp-compositions` `npx remotion compositions src/index.ts` lists the seven presenter/explainer compositions above next to `AudiogramBasic`.

## How to get to it (user POV)

- README section "Selected topic to an explanation video (experimental)"; or ChatGPT through the MCP helper (`continue_explainer`).

## Driving it with clipctl

Preconditions:

- Node >= 22.13; `AUDIOGRAM_DATA_ROOT=$STATE/data`; no LLM/Jev/ElevenLabs credentials.

- **Guards (CLI).** `node scripts/explainer/run.mjs --action get --review <uuid>` → stderr `{"error":"Select a candidate before video production"}`, exit 1; `--action research` without `--revision` → `{"error":"Supply review identity and current revision"}`, exit 1. `node scripts/candidate-review-run.mjs` (no args, bad or unknown input, no provider) → `Candidate review failed. Check provider configuration and saved progress; no video was rendered.`, exit 1.
- **MCP.** Start the helper as in [mcp-helper](./mcp-helper.md); `mcp-modern.mjs URL list_scene_blocks '{}'` prints the three blocks. `get_candidate_review` / `continue_explainer {action:"get"}` with an unknown UUID and `prepare_candidate_review` with `https://example.com/x` return `isError` with a generic message.
- **Compositions.** `npx remotion compositions src/index.ts --browser-executable=$CHROME_PATH` lists them.
- **Unit tests.** `npm run test:explainer` and `npm run test:candidate-review` use fakes (developer signal only).

## Gotchas

- Without a saved candidate review no later step can be driven live. Seeding the review database directly is not a user path, so the research → render chain, narration, scene planning and presenter renders are unverified here.
- The presenter artwork is personal and not in git; an `AnimatedExplainer` render fails or is blank without it.
