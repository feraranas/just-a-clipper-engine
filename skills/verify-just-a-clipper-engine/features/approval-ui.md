# Local approval UI

`node scripts/publishing-server.mjs` serves `public/publishing/` on `http://127.0.0.1:8787/` (`PORT`): the queue of rendered clips with preview, caption edit, approve/schedule, reject, retry, per-item attempt history, and a `Debug jobs ↗` link to the [job debug console](./job-debug-console.md). The old on-page "System logs" activity panel was removed. A verified [explainer](./explainer-workflow.md) render can also appear here after `queue_render` (or automatic registration after render), with an empty caption; queue insertion does not approve or publish it. Approval is local; nothing is posted until `publishing:run --live`.

## Sub-features

- `ui-queue` `GET /api/items` lists queued items; `GET /api/items/<id>` returns one (`404 Item not found`). The card shows state `queued` as `Queued — awaiting approval`.
- `ui-preview` `GET /api/items/<id>/preview` streams the MP4 (`video/mp4`).
- `ui-caption` `POST .../caption {"caption":"..."}` updates the caption.
- `ui-approve` `POST .../approve` (or `.../schedule`) `{"scheduledAt":"<ISO>"}` → `state: approved`, `approvedCaption` set. Without `scheduledAt` → `400 scheduledAt must be a non-empty string`.
- `ui-reject` `POST .../reject {"reason":"..."}` → `state: rejected`.
- `ui-retry` `POST .../retry` only for confirmed safe failures; otherwise `409 Cannot retry without a confirmed safe failure`.
- `ui-history` `GET /api/items/<id>/history` (`Cache-Control: no-store`) → `{"attempts":[...]}`, the latest 20 publishing attempts with outcome, time, sanitized error/provider codes and `recoveredAt` ([instagram-recovery](./instagram-recovery.md)); unknown id → `404 Item not found`. Each card shows `Previous attempt: ...` lines, `No recorded attempts.`, or `History unavailable...` if loading fails.
- `ui-activity` `GET /api/logs?limit=N` still returns `pipeline.jsonl` events (newest first) from `$AUDIOGRAM_DATA_ROOT/pipeline.jsonl` (API only; the page no longer renders it or polls it).

## How to get to it (user POV)

- Run `node scripts/publishing-server.mjs`, open `http://127.0.0.1:8787/`.

## Driving it with clipctl

Preconditions:

- Node >= 22.13; `AUDIOGRAM_DATA_ROOT=$STATE/data` and `PORT=<free port>`; at least one item queued through the real pipeline ([audiogram-url](./audiogram-url.md)). Use a fresh data root (or a second heatmap run) per state you want to test: reject is terminal.

- **Start.** `AUDIOGRAM_DATA_ROOT=$STATE/data PORT=18787 node scripts/publishing-server.mjs`; wait for `Publishing server listening`. `GET /` → 200 HTML. With an empty data root `/api/items` → `{"items":[]}`.
- **Drive.** For the queued id: history (`{"attempts":[]}`), preview (200 `video/mp4`, same duration as the artifact), caption, retry → 409, approve with `scheduledAt`, then `GET /api/items/<id>` shows `approved`. On another item: reject → `rejected`; retry → 409. A non-empty history needs a real publishing attempt (`publishing:run --live`), so only the empty state is driven.
- **Look.** `skills/verify-just-a-clipper-engine/scripts/ui-shot.mjs http://127.0.0.1:18787/ $EVIDENCE/approval-ui.png [WAIT_MS]` prints the page text and saves a 900×1600 screenshot (headless Chrome over DevTools, throwaway profile, removed on exit). Expect the `Debug jobs ↗` link and `1 candidate`, the state label (`QUEUED — AWAITING APPROVAL` / `APPROVED` / `REJECTED`; CSS upper-cases it) and `No recorded attempts.`
- **Activity.** Run [youtube-inbox](./youtube-inbox.md)'s missing-credentials drive against the same data root; `/api/logs` shows its `pipeline` `started`/`failed` events. The page itself shows only the `Debug jobs ↗` link; for an empty queue expect `0 candidates` / `No publishing candidates yet.`

## Gotchas

- `AUDIOGRAM_DATA_ROOT` must be an existing directory: with a missing one the server crashes at startup with `unable to open database file`. `mkdir -p` it first.
- Seeding the queue through ledger internals is not a user path; seed it with `audiogram:url`. A completed explainer render can also enqueue through `queue_render`; that path is not driven here because it needs a verified local render.
- Without `AUDIOGRAM_DATA_ROOT` the server opens the user's real ledger under `~/Library/Application Support/Audiogram Inbox/`.
- `audiogram:url` does not write `pipeline.jsonl`; only `youtube:inbox` does.
- Plain `chrome --headless --screenshot` never finishes on this page (it polls `/api/logs` every 2 s, so virtual time never settles). Use `ui-shot.mjs`, which waits a fixed time.
