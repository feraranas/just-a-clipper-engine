# Local approval UI

`node scripts/publishing-server.mjs` serves `public/publishing/` on `http://127.0.0.1:8787/`: the queue of rendered clips with preview, caption edit, approve/schedule, reject, retry, and a pipeline activity panel. Approval is local; nothing is posted until `publishing:run --live`.

## Sub-features

- `ui-queue` `GET /api/items` lists queued items.
- `ui-preview` `GET /api/items/<id>/preview` streams the MP4.
- `ui-caption` / `ui-approve` / `ui-reject` / `ui-retry` are POSTs that change the ledger row.
- `ui-activity` `GET /api/logs` feeds the activity panel.

## How to get to it (user POV)

- Run `node scripts/publishing-server.mjs`, open `http://127.0.0.1:8787/`.

## Driving it with clipctl

Preconditions:

- `AUDIOGRAM_DATA_ROOT=$STATE/data` and `PORT=<free port>`; at least one item queued through the real pipeline ([audiogram-url](./audiogram-url.md)).

- **Empty queue.** Start `AUDIOGRAM_DATA_ROOT=$STATE/data PORT=18787 node scripts/publishing-server.mjs`, wait for `Publishing server listening`, `curl -s 127.0.0.1:18787/api/items`; expect `{"items":[]}`. Not yet scripted.

## Gotchas

- Not proved. Seeding the queue through ledger internals is not a user path; seed it with `audiogram:url`.
- Without `AUDIOGRAM_DATA_ROOT` the server opens the user's real ledger under `~/Library/Application Support/Audiogram Inbox/`.
