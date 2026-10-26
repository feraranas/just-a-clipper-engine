# Local approval UI

`node scripts/publishing-server.mjs` serves `public/publishing/` on `http://127.0.0.1:8787/` (`PORT`): the queue of rendered clips with preview, caption edit, approve/schedule, reject, retry, and a pipeline activity panel. Approval is local; nothing is posted until `publishing:run --live`.

## Sub-features

- `ui-queue` `GET /api/items` lists queued items; `GET /api/items/<id>` returns one (`404 Item not found`).
- `ui-preview` `GET /api/items/<id>/preview` streams the MP4 (`video/mp4`).
- `ui-caption` `POST .../caption {"caption":"..."}` updates the caption.
- `ui-approve` `POST .../approve` (or `.../schedule`) `{"scheduledAt":"<ISO>"}` → `state: approved`, `approvedCaption` set. Without `scheduledAt` → `400 scheduledAt must be a non-empty string`.
- `ui-reject` `POST .../reject {"reason":"..."}` → `state: rejected`.
- `ui-retry` `POST .../retry` only for confirmed safe failures; otherwise `409 Cannot retry without a confirmed safe failure`.
- `ui-activity` `GET /api/logs?limit=N` returns `pipeline.jsonl` events (newest first) from `$AUDIOGRAM_DATA_ROOT/pipeline.jsonl`.

## How to get to it (user POV)

- Run `node scripts/publishing-server.mjs`, open `http://127.0.0.1:8787/`.

## Driving it with clipctl

Preconditions:

- Node >= 22.13; `AUDIOGRAM_DATA_ROOT=$STATE/data` and `PORT=<free port>`; at least one item queued through the real pipeline ([audiogram-url](./audiogram-url.md)). Use a fresh data root (or a second heatmap run) per state you want to test: reject is terminal.

- **Start.** `AUDIOGRAM_DATA_ROOT=$STATE/data PORT=18787 node scripts/publishing-server.mjs`; wait for `Publishing server listening`. `GET /` → 200 HTML. With an empty data root `/api/items` → `{"items":[]}`.
- **Drive.** For the queued id: preview (200 `video/mp4`, same duration as the artifact), caption, approve with `scheduledAt`, then `GET /api/items/<id>` shows `approved`. On another item: reject → `rejected`; retry → 409.
- **Activity.** Run [youtube-inbox](./youtube-inbox.md)'s missing-credentials drive against the same data root; `/api/logs` shows its `pipeline` `started`/`failed` events.

## Gotchas

- Seeding the queue through ledger internals is not a user path; seed it with `audiogram:url`.
- Without `AUDIOGRAM_DATA_ROOT` the server opens the user's real ledger under `~/Library/Application Support/Audiogram Inbox/`.
- `audiogram:url` does not write `pipeline.jsonl`; only `youtube:inbox` does.
- Headless Chrome `--screenshot` of the page did not finish within 60 s (`--virtual-time-budget`); proof here is API level, not visual.
