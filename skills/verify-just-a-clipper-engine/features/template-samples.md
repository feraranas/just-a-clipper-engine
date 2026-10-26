# Template sample server

A neutral Classic V1 sample for public previews. `npm run samples:render` narrates `fixtures/template-samples/classic-v1/sample.json` with macOS `say`, renders it with `AudiogramBasic`, validates the media and writes a revision plus `registry.json` under the sample root. `npm run samples:serve` serves the page and poster from that registry on `http://127.0.0.1:8790/` (`AUDIOGRAM_SAMPLE_PORT`).

## Sub-features

- `samples-render` writes `<root>/registry.json` and a revision dir; one writer at a time (`.render-lock`).
- `samples-root` the root is `AUDIOGRAM_SAMPLE_ROOT` or `<AUDIOGRAM_DATA_ROOT>/template-samples`; it must be absolute and outside any Git checkout.
- `samples-page` `GET /samples/classic/1/default/` returns HTML with a strict CSP (`media-src https://media.ferarana.work`) and a `<video>` that points to the registry `videoUrl`.
- `samples-poster` `GET .../poster.jpg` (`no-cache`) and `.../poster/<sha256>.jpg` (immutable, `ETag`, `304` on `If-None-Match`).
- `samples-health` `GET /health` → `{"status":"ok"}`; non-GET/HEAD → `405`; unknown path → `404 Sample not found.`

## How to get to it (user POV)

- `npm run samples:render` (macOS), then `npm run samples:serve`.

## Driving it with clipctl

Preconditions:

- Node >= 22.13. A scratch root such as `AUDIOGRAM_SAMPLE_ROOT=$STATE/samples`.

- **Render guard (Linux).** `AUDIOGRAM_SAMPLE_ROOT=$STATE/samples npm run samples:render` → `Sample render failed: spawn /usr/bin/say ENOENT`, exit 1, no `.render-lock` left.
- **Serve without registry.** `npm run samples:serve` → `Sample server could not start: ENOENT ... registry.json`, exit 1. A root inside the checkout → `Sample assets must remain outside the source checkout.`
- **Serve.** On Linux, seed the root by hand (harness scaffolding, not the user path): write `rev1/poster.jpg` (for example `ffmpeg -ss 2 -i $STATE/candidate.mp4 -frames:v 1`) and `registry.json` `{"contractVersion":1,"samples":[{"templateId":"classic","templateVersion":"1","variationId":"default","poster":"rev1/poster.jpg","posterHash":"<sha256>","videoHash":"<sha256>","videoUrl":"https://media.ferarana.work/templates/classic/v1/demo.mp4"}]}`. Start with `AUDIOGRAM_SAMPLE_PORT=18790`; expect `Sample server listening at http://127.0.0.1:18790/samples/classic/1/default/`, then curl the routes above.

## Gotchas

- `samples:render` is unreachable on Linux (needs `/usr/bin/say` with the Samantha voice). Report it as unverified there.
- The server reads the registry only at startup; restart it after a render.
