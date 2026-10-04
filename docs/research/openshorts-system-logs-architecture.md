# OpenShorts System Logs: architecture and UI build

## Scope and evidence

Descriptive reference for borrowing OpenShorts' existing logging experience in Audiograms. This is documentation, not an implementation proposal or a change to either application's behavior.

Inspected 2026-10-01 in `/Users/kiwi/external/openshorts`, based on commit `faff66de0b91277510587a1c778be433ff3d26a4` plus the existing local Upload-Post feature-flag changes. The supplied `system_logs.mov` shows this dashboard's System Logs panel during moment selection, clip rendering, failure, and automatic retry. Source inspection establishes the behavior below; no new pipeline job was run for this document.

Audiograms comparison source: [`scripts/AGENTS.md`](../../scripts/AGENTS.md), the user's descriptive snapshot of the existing structured pipeline logger.

## End-to-end flow

```text
main.py and pipeline helpers
  print progress, warnings, stage details, and clip messages
    │  Python runs unbuffered; stderr merges into stdout
    ▼
app.py: run_job → subprocess.Popen
    │  dedicated daemon thread reads subprocess.stdout.readline()
    ▼
app.py: enqueue_output
  decode UTF-8 → strip whitespace → scrub URL credentials
  consume internal control markers separately
    ├─ server console: 📝 [Job Output] …
    └─ jobs[job_id]['logs']: _TimedLog
         ordered strings + parallel arrival timestamps in memory
              │
              ▼
GET /api/status/{job_id}
  check ownership → choose raw or friendly view
  return status + logs + log_times + results + queue + partial
              ▲
              │ browser polls every 2 seconds
              ▼
dashboard/src/App.jsx
  logs / logTimes / status React state
    └─ collapsible System Logs panel
       timestamp column + wrapped monospace messages + busy cursor
```

There is no SSE or WebSocket transport in this log path. The near-real-time experience comes from continuous backend capture plus frequent HTTP polling. The panel represents one job, not a machine-wide log aggregator.

## Producers, capture, and timestamps

The process endpoint builds `[sys.executable, "-u", "main.py", …]`. Python's unbuffered mode helps messages reach the parent promptly. Pipeline helpers also explicitly flush some progress messages; for example, `transcribe_backends.py` prints transcription percentages with `flush=True`.

`run_job` changes the job to `processing`, appends `Job started by worker.`, and starts the subprocess with `stdout=PIPE` and `stderr=STDOUT`. A daemon thread runs `enqueue_output` so blocking pipe reads do not block the async HTTP event loop. The worker itself checks process completion and partial results approximately every two seconds.

For each nonempty decoded line, `enqueue_output` applies `_scrub_secrets`, echoes the text to the server console, and appends it to that job's `_TimedLog`. The timestamp is the server's `time.time()` when the line is appended, expressed as epoch seconds. It is an arrival time, not necessarily the exact time the underlying operation happened. Lines supplied together to `_TimedLog` initialization or `extend` share that batch's timestamp.

Three prefixes carry control information rather than visible messages:

| Prefix | Consumer behavior |
| --- | --- |
| `CLIP_READY <index> <filename>` | Records a completed clip filename in `ready_files`; lets the result panel show a finished artifact during processing. |
| `PROXY_BYTES=` | Records proxy byte usage for the job. |
| `PROXY_ROUTE=` | Parses download-route accounting metadata. |

These markers are removed from the user log. Regular human-readable clip progress still appears. A line-oriented reader can delay carriage-return-only progress until a newline or end of stream; unbuffered Python does not guarantee every external program's progress redraw appears immediately.

## Log data and API contract

The application holds `jobs` as a process-local dictionary. Each job has its status, command/environment, results, and a `_TimedLog`, which subclasses `list` and stores timestamps in a separate `.times` array.

There is no structured per-line schema for severity, stage, event ID, or duration. Correlation comes from the containing `job_id`; most semantics remain in message text.

Illustrative status response:

```json
{
  "status": "processing",
  "logs": ["Job started by worker.", "🎙️ Transcribing… 25% (3s)"],
  "log_times": [1790890000.1, 1790890003.2],
  "result": null,
  "queue": null,
  "partial": null
}
```

`GET /api/status/{job_id}` checks job ownership through `_assert_job_owner` before returning the view. If the job is absent from memory, it attempts reconstruction from disk; an unknown job returns 404. `log_times` can be null when timing information is unavailable or its length no longer matches the log list.

Each response contains the accumulated visible log, with no cursor, offset, or requested tail limit. The inspected capture path does not cap `_TimedLog` length. Longer jobs therefore increase memory usage, response size, and browser rendering work.

## Raw and friendly views

Self-host mode (`BILLING_ENABLED` off) returns the captured text. `DEBUG_LOGS=true` also selects full output in billing mode.

Otherwise, `log_view.py` produces a whitelist-based customer view:

- Recognized messages become readable progress such as downloading, transcribing, finding moments, choosing a layout, and creating clips.
- Unmatched technical messages are hidden, including most provider, encoder, and model internals.
- Download and transcription percentages update their existing progress rows instead of creating a row for every percentage. Those rows retain the time they first appeared.
- Consecutive duplicate messages collapse. Carriage-return segments and certain joined progress messages are separated before matching.
- Recognized error/lifecycle messages are retained with path-like tokens removed.

The capture scrubber specifically masks `user:password@` credentials inside URLs. It is not a comprehensive API-key, transcript, or personal-data redactor. The self-hosted view can include paths, model information, and any content printed by pipeline code. The `_SENSITIVE_LOG_RE` declaration is not the active whitelist implementation used by `_visible_logs_timed`.

## Browser updates and job lifecycle

`App.jsx` owns the log feature directly; there is no separate reusable System Logs component. Its state includes `logs`, `logTimes`, `logsVisible`, `status`, and `jobId`.

After submission, the UI initializes the log with `Starting process...`. A React effect installs a two-second `setInterval` while the UI status is `processing` or `completed` and a job ID exists. `pollJob` uses the shared `apiFetch` wrapper, which resolves the API URL and attaches an available bearer token.

On each response, the UI updates any available results and queue information. For a nonterminal response it replaces `logs` and `logTimes` with the server arrays. On `completed`, it sets the UI state to `complete`, stops the interval, and refreshes account information. On `failed`, it sets the UI state to `error`, derives an error message, appends it locally, and stops polling.

Important current behavior: the completion and failure branches do not first copy the final response's complete log arrays. The last server messages can therefore be missing from the panel. The locally appended error also has no corresponding timestamp entry. Polling exceptions go to the browser console; the panel does not display a disconnected/stale-data indicator. Async interval requests have no explicit in-flight guard or cancellation, so slow requests can overlap.

Server lifecycle messages include queued, started, success, nonzero exit code, missing metadata, and failed renders. A zero subprocess exit can subsequently become a failed job if usable outputs are missing. Automatic retry uses the same job's log and appends a retry message; failure classification itself examines log text (`is_transient_failure`). Logging content consequently has an operational role beyond display.

## UI construction and visual treatment

The panel lives in the dashboard's left processing card, below the media preview and processing feedback, alongside a right-hand results area. The visual effect is ordinary React markup and CSS, not a terminal emulator, canvas renderer, or Remotion composition.

| Element | Existing implementation |
| --- | --- |
| Shell | Dark `bg-paper` surface, one-pixel `border-rule`, 10px rounded card, clipped overflow, vertical flex layout. |
| Header | Slightly lighter `bg-paper2`, full-width button, Terminal icon, uppercase `System Logs` label, count when collapsed, rotating ChevronDown. |
| Typography | JetBrains Mono with system monospace fallbacks; messages 11px on narrow screens and Tailwind `text-xs` from `sm`; uppercase readout label with letter spacing. |
| Rows | Flex layout with a dim fixed-width timestamp area and wrapping message text; 1.5 spacing utility between rows. |
| Time display | `new Date(logTimes[i] * 1000).toLocaleTimeString()` uses the browser's locale/time zone; timestamp column hidden below `sm`. |
| Color | Most text is muted; messages containing case-insensitive `error` use `text-danger`. Emoji come from the message itself, not a severity-icon mapper. |
| Busy state | A pulsing accent-colored underscore appears while the UI is processing. |
| Scrolling | Scrollable body and a six-pixel custom WebKit scrollbar. No explicit auto-follow, scroll-to-bottom, or pause-follow controller was found in this panel. |
| Collapse | Button exposes `aria-expanded`; body is conditionally rendered. It initializes expanded at viewport widths of at least 768px. |
| Small screens | Latest message appears separately with a spinner below `sm`, keeping progress visible even when the terminal is collapsed. |
| Completion | Expanded panel shrinks to `h-32` and fades to 50% opacity, returning to full opacity on hover. |

`dashboard/src/tokens.css` defines the design palette: paper `oklch(13% 0.014 265)`, paper-2 `oklch(16.5% 0.015 265)`, muted text `oklch(64% 0.012 262)`, and orange accent `oklch(76% 0.17 50)`. `tailwind.config.js` maps tokens into utilities. `index.css` supplies `.readout`, `.card`, focus styles, and `.custom-scrollbar`.

The polished appearance comes from this shared typography, spacing, surface, and border system. There is no search, severity filter, log export, row virtualization, or dedicated live-region announcement in the inspected panel. Error coloring is a text heuristic: a line saying only `Process failed...` need not be colored red.

## UI build and serving

Declared frontend stack: React/React DOM `^18.2.0`, Vite `^4.5.3`, Tailwind CSS `^3.4.19`, and `lucide-react` `^0.344.0`. These are package ranges, not a statement of the installed versions. Remotion packages are used elsewhere in the application and are not involved in rendering the log panel.

`dashboard/src/main.jsx` imports `index.css`, mounts the React application, and lazy-loads `App.jsx`. Hash routing selects the dashboard at `#app`. `AuthProvider` supplies billing configuration used elsewhere in the dashboard; backend mode decides which log view the API returns.

Local Docker flow:

```text
browser localhost:5175
  → Compose frontend port mapping 5175:5173
  → dashboard/Dockerfile dev stage: Node 18 Alpine + Vite --host
  → mounted dashboard source, with container node_modules
  → Vite /api proxy → backend:8000
```

Vite's default API proxy target is `http://backend:8000`; `VITE_PROXY_TARGET` can override it. `dashboard/src/config.js` uses `VITE_API_URL` when supplied and otherwise uses relative URLs. The separate renderer service at port 3100 does not transport these logs.

Production flow: the Dockerfile's build stage installs frontend dependencies and runs `npm run build`; the final nginx stage serves `dist` on port 80. `VITE_API_URL` is a build-time argument. Unlike the Vite dev server, the inspected nginx configuration does not proxy `/api`, so deployment needs an appropriate API URL or routing outside that nginx configuration. Hashed assets receive long-lived caching; HTML is served with no-store behavior.

Package scripts are `dev` (Vite), `build` (Vite build), `lint` (ESLint), and `preview` (Vite preview). The SEO build plugin also emits public pages; it is separate from the runtime log panel. There is no dedicated log UI build step.

## Persistence, recovery, and failure boundaries

The visible raw log and original per-line timestamps live in the API process's memory. There is no JSONL persistence in this path. Echoed output may remain in Docker's container logs according to Docker configuration, but the dashboard does not read those logs back.

Resume manifests, metadata, owner files, and transcript checkpoints serve job recovery and artifacts. They do not reproduce the original log history. Recovered jobs receive synthetic messages such as `Job recovered from disk after server restart.` During a handover, a status response reconstructed from a live manifest can contain only the server-update message.

The browser persists job/session details to localStorage, with a 24-hour session age limit, but its saved session object excludes `logs` and `logTimes`. An active session resumes polling; a restored terminal session does not automatically recover its previous raw log tail through that polling effect.

Capture errors are caught by `enqueue_output` and printed to the server console. That avoids deliberately raising them into `run_job`, but the reader closes its pipe on exit; this is not a guarantee that capture failure cannot affect the child. The worker also does not explicitly join the log reader before final status handling, leaving a possible race with the final lines.

## Comparison with the Audiograms snapshot

| Dimension | OpenShorts | Audiograms `scripts/AGENTS.md` snapshot |
| --- | --- | --- |
| Producer | Detailed human-readable subprocess output and worker messages | Allowlisted structured stage events |
| Correlation | Per-job container and URL | `runId` in each record |
| Granularity | Transcription percentages, selection details, per-clip steps, failures/retries | Two broad stage pairs |
| Delivery | Automatic two-second full-snapshot polling | Fetch on page load/manual refresh |
| Storage | In-memory tail; separate operational console output | Append-only JSONL |
| Presentation | Styled collapsible terminal, real arrival times, mobile progress, busy cursor | Activity list showing timestamp/stage/status |
| Recovery | Job can recover without original log history | Log records remain on disk |
| Main tradeoff | Rich immediate feedback, weak durable/structured log history | Structured durable records, limited immediate feedback |

The reusable ideas are detailed progress messages throughout long stages, source timestamps, automatic refresh, and the responsive terminal treatment. Persistent structured events and the live presentation are separate concerns; OpenShorts does not already combine all of them into a durable event system.

## Source map and existing tests

Paths below are relative to `/Users/kiwi/external/openshorts`:

| Source | What to inspect |
| --- | --- |
| `app.py` | `_TimedLog`, `enqueue_output`, `run_job`, `_visible_logs_timed`, `/api/status/{job_id}`, `_job_view_from_disk`, `_schedule_auto_retry` |
| `main.py`, `transcribe_backends.py` | Progress producers, clip lifecycle text, explicitly flushed transcription progress |
| `log_view.py` | Friendly-view rules, deduplication, percentage updates, timestamp preservation |
| `dashboard/src/App.jsx` | `pollJob`, polling effect, session persistence, System Logs JSX |
| `dashboard/src/lib/api.js`, `dashboard/src/config.js` | Authentication headers and API URL resolution |
| `dashboard/src/main.jsx` | Entry point, stylesheet import, lazy app loading, hash routing |
| `dashboard/src/tokens.css`, `dashboard/src/index.css`, `dashboard/tailwind.config.js` | Visual tokens, reusable classes, responsive styling |
| `dashboard/package.json`, `dashboard/vite.config.js`, `dashboard/Dockerfile`, `dashboard/nginx.conf`, `docker-compose.yml` | UI build and local/production serving |
| `tests/test_log_view.py` | Friendly formatting, path removal, hidden internals, duplicates, joined progress, timestamp behavior |
| `tests/test_clip_ready_marker.py` | Control marker handling and exclusion from visible logs |
| `tests/test_auto_retry.py`, `tests/test_job_error_text.py` | Failure interpretation and retry behavior connected to log content |

The dashboard package defines no test script. The tests above were inspected as evidence of intended coverage, not executed for this documentation task. Source-level limitations described here are observations, not changes made to OpenShorts.
