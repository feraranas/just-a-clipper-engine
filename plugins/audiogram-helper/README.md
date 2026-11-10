# Audiogram Helper (local MCP)

This development adapter accepts one YouTube video URL, queues the existing Audiograms CLI in a detached local worker, and reports verified MP4 drafts under `out/treatments/`. It does not publish or upload clips. The job ledger lives in the ignored `.local/audiogram-helper-jobs.sqlite` file.

## Prerequisites

- Node.js 22.13.0 or newer (supports optional env-file loading and the built-in SQLite module without an extra flag)
- Install repository dependencies with `npm ci`
- The existing Audiograms prerequisites for fetching and rendering: `yt-dlp`, FFmpeg, and ffprobe
- OpenAI Secure MCP Tunnel available in your ChatGPT Developer Mode environment

## Start and connect

1. Copy `.env.example` to `.env` in the Audiograms repository root.
2. Set `AUDIOGRAM_LLM_PROVIDER` to `chatgpt-oauth` or `openai-api`. The `openai-api` provider also requires `OPENAI_API_KEY`. For `chatgpt-oauth`, use the default external credential location from `npm run chatgpt:login`; a custom `AUDIOGRAM_CHATGPT_AUTH_PATH` must be absolute and outside the repository. Jev is enabled in the example: replace the placeholder with your HTTPS `TYPESAFE_JEV_ENDPOINT` and supply your `TYPESAFE_JEV_API_KEY`. The server will not start until these settings are configured. To explicitly opt out of Jev, clear both values.
3. From the repository root, run `npm run audiogram:mcp`. The command loads `.env` when that file exists. It checks required settings before it opens the MCP port. It prints setting names in errors, never secret values.
4. Confirm the terminal reports `http://127.0.0.1:7331/mcp`. The process binds only to loopback; do not change the bind address or expose the port publicly.
5. In ChatGPT, enable Developer Mode and add a custom MCP app using the Secure MCP Tunnel workflow. Select this local service at `http://127.0.0.1:7331/mcp` as the tunnel target, then finish the connection in the developer UI.
6. In ChatGPT, submit one public YouTube video URL. The `create_audiogram` tool returns a job ID; call `get_audiogram_status` with that ID until it is terminal. Completed results contain repository-relative local artifact paths, not public download links.

The Secure MCP Tunnel is a private development bridge, not hosting. The tunnel configuration and credentials remain in the user/account environment and are not stored by this project. A service restart preserves recorded job outcomes; a worker that disappears before recording its result is reported as failed.

## MCP protocol foundation

The HTTP endpoint supports modern protocol `2026-07-28` through the released
MCP v2 handler and preserves stateless legacy clients. Existing create, status,
retry, and template-listing tools and the template preview resource remain.
Modern requests must use the protocol's matching version/method/name headers;
the pinned v2 client handles this automatically.

This protocol slice does **not** advertise Events support or implement job
subscriptions, webhooks, progress delivery, or automatic chat updates. Those
remain later slices of the live-stage-events plan. No service is started or
restarted by installing dependencies. Start MCP visibly using the command above.

## Cloud runtime boundary

The same command can run in a cloud host. The host must provide runtime settings as environment variables and secrets through its secret manager. The `.env` file is optional and must not be copied into a container image or committed. Startup validation uses the environment that the host provides before the service accepts jobs.

This does not deploy Cloud Run or configure its secrets. The local `chatgpt-oauth` credentials are not suitable for a shared server. A public service needs a separate per-user OAuth design before it can use that provider for multiple users. The cloud runner and artifact store also remain future work.

## Tools

- `create_audiogram({ url })`: validate the supported YouTube URL, create or reuse an active local job for that video, and return its opaque job ID.
- `get_audiogram_status({ jobId })`: return status and, only after verification, local artifact paths.
- `retry_audiogram({ jobId })`: start a new linked attempt for a failed or partial job. ChatGPT must ask the user before calling it.

## Local diagnostics

Each job keeps structured stage events and separate worker/CLI stdout and stderr files under `.local/audiogram-helper/runs/<jobId>/`. Each stream file is capped at 2 MiB by default; set `AUDIOGRAM_DIAGNOSTICS_MAX_FILE_BYTES` to a value from 1 KiB through 50 MiB to change that limit. The default retention period is 30 days; set `AUDIOGRAM_DIAGNOSTICS_RETENTION_DAYS` to a whole number from 1 through 3650 to change it. The next job creation removes older job folders. Run `npm run audiogram:logs -- --job-id <UUID>` to print safe structured events for one job. This command does not print local paths or raw process output. Raw stream files stay local and do not appear in MCP results. A `partial` result means at least one verified artifact exists; the `failures` list identifies failed stages or packages. Retry creates a new job ID and does not retry automatically.

## Template choice

Call `list_video_templates` with `{}` to discover the supported designs.
It returns `contractVersion: 1`, descriptions, supported input types, variations,
and a `defaultSelection` for each template. It does not start a job or check
provider readiness. Classic uses `create_audiogram`; Animated Explainer uses
`prepare_candidate_review`, `select_candidate_review`, and `continue_explainer`.
It requires script and narration approval, local presenter assets and Rhubarb.

Classic V1's default variation includes `preview.pageUrl`, `preview.posterUrl`,
and `preview.videoUrl`, hosted at `https://media.ferarana.work/templates/classic/v1/`.
Show the returned clickable preview link so the user can watch before choosing.
The browser loads the sample directly from Hetzner; the tool does not download
or proxy media. Other variations omit `preview` until a sample is published.
`video-configured` describes a configured URL, not a live availability check.
The tool also advertises an inline MCP Apps player at
`ui://video-templates/v1.html`. The server bundles its UI at startup. A bundle
failure stops startup before the listener opens. Compatible hosts display a
card with native video controls; other hosts retain the text preview link.
The UI uses the MCP Apps bridge and allows media only from the Hetzner origin.
It cannot create jobs. Playback needs no additional credentials.

Restart the MCP service and refresh its tools in ChatGPT to load these changes.
To add or withdraw a public sample, edit `template-previews.mjs` using the exact
template/version/variation identity. Verify the page, poster and MP4 range
response before adding a mapping. Never use private job media in this map.
Animated Explainer is listed without a public sample. Its rendered files and
audio remain local paths; the plugin does not provide hosted playback. Restart
the MCP server and refresh the connection after deploying this change so
clients can discover the candidate and explainer tools.

`create_audiogram` accepts optional `templateId`, `templateVersion` and `variationId` fields.
The current values are `classic`, `1` and `default`.
Omitted fields use those defaults. Invalid choices fail before job creation.

The job store records the canonical choice. The detached worker forwards that choice to the CLI.
An active request for the same video and render identity reuses the existing job.
A request for another template while that video is active returns a conflict.
This preserves one active worker per video and prevents races during asset acquisition.
The helper does not reuse completed jobs. The pipeline ledger can reuse completed renders.

The store migrates old records to Classic / Default in a transaction.
Existing job IDs, statuses and results remain intact.
Tests use temporary databases. Development verification does not migrate the user's live job database.

## Local template sample page

Generate the original Classic V1 demonstration and start its dedicated server:

```sh
npm run samples:render
npm run samples:serve
```

Generation requires macOS with the Samantha voice, FFmpeg, and ffprobe.
Open [the local sample page](http://127.0.0.1:8790/samples/classic/1/default/).
The page initially shows a poster and an unavailable-video message. Stop the
foreground server with Ctrl+C. No background service is installed.

The sample server reads `<AUDIOGRAM_DATA_ROOT>/template-samples/registry.json`.
`AUDIOGRAM_SAMPLE_ROOT` overrides the asset root. It must be absolute and outside
Git checkouts. `AUDIOGRAM_SAMPLE_PORT` overrides 8790. A busy port fails instead
of silently selecting another port. Both commands load `.env` when it exists.

For the Cloudflare published application, enter:

| Field | Value |
| --- | --- |
| Subdomain | `samples` |
| Domain | `ferarana.work` |
| Path | Leave empty |
| Service URL | `http://127.0.0.1:8790` |
| Additional settings | Keep defaults |

The user saves this route. This code does not configure the tunnel or DNS.
After saving, verify the HTTPS sample page and its poster. `/mcp`, `/api/items`,
MP4 paths, and unknown paths must return 404 from this server.

For playback, first select a suitable external video host and upload the local
sample there. Add its public HTTPS URL as `videoUrl` on the matching registry
entry, then restart the sample server. URLs with embedded credentials are
rejected. The browser loads the video directly. The server never proxies it.
The host must support browser playback and byte-range requests. CSP permits
only the configured video origin, so cross-origin redirects need compatible
hosting. Test actual playback before claiming the preview works.

This page is separate from the MCP tools. It does not create a ChatGPT preview
card or change `list_video_templates`. That integration remains separate work.

## Candidate review before making an explanation video

The candidate-review tools reuse transcript extraction, the current LLM selector,
and Jev. They save a review in the shared data folder, not in the source checkout.
They do not generate a script, narration, video, or publishing item.

- `prepare_candidate_review`: supply a public YouTube URL and a UUID requestId.
- `get_candidate_review`: supply the returned reviewId to read saved progress,
  candidates, timestamped evidence, exact questions, and raw Jev answers.
- `select_candidate_review`: supply reviewId, reviewHash, and the candidateId the
  user explicitly chose. The fingerprint prevents selection against changed data.

An identical preparation request ID retrieves its prior progress. A different
source cannot reuse that ID. Explicit retry uses a new requestId. Inspect uncertain
attempts first, since another request can incur another provider charge.

The first version intentionally uses the existing clip-drafting recipe and its
length/count constraints. Eight existing framework questions receive per-candidate
scores for inspection. The overall ranking retains the existing relevance,
insight, and self-containedness weights. It does not select a topic automatically.
Missing Jev or LLM configuration prevents preparation. Reading a saved review
and selecting a topic do not require provider credentials.

From this checkout, use the existing environment setup and run:

```sh
npm run candidates:review -- --url "https://www.youtube.com/watch?v=_U-O5lYhJ7Q"
npm run candidates:review -- --review REVIEW_ID
npm run candidates:review -- --review REVIEW_ID --hash REVIEW_HASH --select candidate-1
```

The shared file is `candidate-reviews.sqlite` under AUDIOGRAM_DATA_ROOT.
Output includes public source text, so avoid publishing full trial output by accident.
Start the MCP server from this checkout to load the added tools. Existing running
servers do not acquire new tools until restarted with this code.

### Review the explainer audio and video locally

The connected app does not upload or stream private explainer files. After
`narrate` completes, call `continue_explainer` with `action: get` and the
review ID. Ask the user to open `documents.audio.path` on the Mac running
this service and listen. Only after the user accepts that recording, call
`accept_audio` with `documents.audio.sha256` and the current revision.
After render completes, `get` returns the video path in `documents.render.path`.
The user can open that local file. A user who cannot access the service's Mac
cannot currently listen to or view these files through ChatGPT.
