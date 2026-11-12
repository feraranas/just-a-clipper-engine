# MCP helper

`npm run audiogram:mcp` starts a Streamable-HTTP MCP server on `http://127.0.0.1:7331/mcp` (`AUDIOGRAM_MCP_PORT`) for ChatGPT Developer Mode. It serves the modern protocol `2026-07-28` through the MCP v2 handler (`@modelcontextprotocol/server`, `plugins/audiogram-helper/mcp-http.mjs`) and still accepts stateless legacy clients (`initialize`, for example `2025-06-18`). Tools: `list_video_templates`, `create_audiogram`, `get_audiogram_status`, `retry_audiogram`, plus the explanation-video tools `list_scene_blocks`, `continue_explainer`, `prepare_candidate_review`, `retry_candidate_review`, `get_candidate_review`, `select_candidate_review` (see [explainer-workflow](./explainer-workflow.md)); `tools/list` returns all ten. Jobs run the direct-URL pipeline in a detached worker and record state in `.local/audiogram-helper-jobs.sqlite` (gitignored, in the checkout).

## Sub-features

- `mcp-templates` `list_video_templates({})` returns `contractVersion: 1` and two designs: Classic V1 / `default` (with a `preview`: `video-configured`, page/poster/video URLs on `https://media.ferarana.work/templates/classic/v1/`) and Animated Explainer V1 (`templateId: "animated-explainer"`, version `1`, variation `default`, `workflow: "explainer"`, no hosted preview). The tool text tells the client to start the explainer with `prepare_candidate_review` and never send that selection to `create_audiogram`. The tool advertises the inline UI `ui://video-templates/v1.html` (`text/html;profile=mcp-app`, CSP resource domain `https://media.ferarana.work`).
- `mcp-create` `create_audiogram({url, templateId?, templateVersion?, variationId?})` validates the URL and selection before creating a job; returns `jobId`, `status: running`.
- `mcp-status` `get_audiogram_status({jobId})` returns `complete` with `artifacts` paths relative to `AUDIOGRAM_DATA_ROOT` (`artifacts/<hash>/<hash>/video.mp4`).
- `mcp-retry` `retry_audiogram({jobId})` only for failed/partial jobs; a completed job returns `isError` `This Audiogram job cannot be retried.`
- `mcp-logs` `npm run audiogram:logs -- --job-id <UUID>` prints the job's stage events (`intake` … `artifact_verification`). Without `--job-id` it prints `jobId must be a valid UUID`.
- `mcp-explainer-tools` `tools/list` (either era) includes the six explainer/candidate tools above, including `retry_candidate_review`. Offline calls: `list_scene_blocks({})` → exactly three version-1 blocks: `comparison`, `process`, `branch`; unknown review ids, `retry_candidate_review` with unknown ids, and bad URLs return `isError` with a generic message.
- `mcp-guard` requests with a non-loopback `Host` get `403`.
- `mcp-modern` `server/discover` lists `supportedVersions: ["2026-07-28"]` and `tools`/`resources` capabilities, with no `events` capability. Modern requests must send `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` (for `tools/call` / `resources/read`). If one is missing, the response is HTTP 400, JSON-RPC `-32020` (`the request headers and body disagree`). The pinned client `@modelcontextprotocol/client` 2.4.0 sends them for you.
- Job progress/finish events (`plugins/audiogram-helper/mcp-event-contract.mjs`, `audiogram.job.progress` / `audiogram.job.finished`) are only a tested contract. They are not wired into the server and are not user-visible yet.

## How to get to it (user POV)

- `npm run audiogram:mcp`, then connect ChatGPT through the Secure MCP Tunnel (`plugins/audiogram-helper/README.md`).

## Driving it with clipctl

Preconditions:

- Node >= 22.13, dependencies current (`clipctl doctor`), no `.env` in the checkout (or one without secrets). The startup check needs either `AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap` (no LLM) or an LLM provider, and both or neither of `TYPESAFE_JEV_ENDPOINT`/`TYPESAFE_JEV_API_KEY`.

- **Start.** `AUDIOGRAM_DATA_ROOT=$STATE/data AUDIOGRAM_DIAGNOSTICS_ROOT=$STATE/diag AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap AUDIOGRAM_MCP_PORT=17331 node --env-file-if-exists=.env plugins/audiogram-helper/server.mjs`. Expect `Audiogram MCP listening on http://127.0.0.1:17331/mcp`.
- **Call (legacy era).** `curl -s -H content-type:application/json -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_video_templates","arguments":{}}}' http://127.0.0.1:17331/mcp` (response is one SSE `data:` line). Same shape for `tools/list`, `resources/read` and the other tools.
- **Call (modern era).** `skills/verify-just-a-clipper-engine/scripts/mcp-modern.mjs http://127.0.0.1:17331/mcp [TOOL [JSON_ARGS]]` connects with the pinned v2 client. It prints `{"era":"modern",...}`, the tool names and, optionally, one tool result. Exit 1 on `isError`. For raw modern requests, add the three headers and the `_meta` `io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}` params (see `mcp-http.test.mjs`).
- **Job.** `create_audiogram` with a public video, through either era; poll `get_audiogram_status` until `complete` (about 10 s with the heatmap selector); then `AUDIOGRAM_DIAGNOSTICS_ROOT=$STATE/diag npm run audiogram:logs -- --job-id <id>`.
- **Console.** A job created here (failed or complete) is visible in the [job debug console](./job-debug-console.md) when the publishing server points `AUDIOGRAM_DEBUG_JOBS_DB_PATH` at `.local/audiogram-helper-jobs.sqlite` (the default) and `AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT` at this run's `$STATE/diag`.
- **Validation.** `url: https://example.com/x` → `URL host is not a supported YouTube host.`; `templateId: nope` or `templateId: animated-explainer` → `Unknown template selection. Available: classic / 1 / default.` (the Classic catalog used by `create_audiogram` still rejects the explainer identity); unknown job → `Audiogram job was not found.`

## Gotchas

- The UI bundle is built with esbuild at startup and needs `@modelcontextprotocol/ext-apps`. A stale `node_modules` fails startup with `Could not resolve "@modelcontextprotocol/ext-apps"`; rerun `clipctl launch`.
- Cleanup: stop the server, then delete the `.local/audiogram-helper-jobs.sqlite*` files if this run created them. Pipeline intermediates also land in the checkout (see [audiogram-url](./audiogram-url.md)).
- The preview links are public HTTPS reads; the default LLM selector is a paid/OAuth call and is not used for verification.
