# Audiogram Inbox

Audiogram Inbox turns the strongest YouTube Most Replayed moment from videos in
a private playlist into reusable clip packages and rendered Remotion artifacts.

V1 registers one treatment, `audiogram-basic@1`, but discovery, package assets,
the SQLite ledger, and the renderer are treatment-independent.

## Run the MVP

Prerequisites:

- Node.js 22
- yt-dlp
- FFmpeg and ffprobe
- A Google desktop OAuth client authorized for read-only YouTube access

Install locked dependencies and run the pipeline:

```console
npm ci
npm run youtube:inbox
```

On first authorization, open the printed Google OAuth URL. The pipeline looks
for a private playlist named `Audiogram Inbox` by default.

## Verify development changes

```console
npm run test:youtube
npm run lint
npx remotion compositions
```

Open the composition interactively:

```console
npm run dev
```

## Runtime outputs

Clip packages are generated under:

```text
public/generated/<video-id>/<package-version>/clip-<rank>/
```

Rendered treatment artifacts are published under:

```text
out/treatments/<treatment-id>/<treatment-version>/<video-id>/
```

Both directories are ignored by Git. OAuth credentials and the SQLite ledger
live in `~/Library/Application Support/Audiogram Inbox/` and must not be
committed.

The default workflow downloads only the selected audio interval. It never
silently falls back to downloading the full video. V1 uses YouTube creator or
automatic captions only; local Whisper is planned for V2.

## Documentation

- [Project status and operational handoff](docs/PROJECT_STATUS.md)
- [Generic package and treatment design](docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-18-clip-package-treatment-registry.md)

## Remotion licensing

This project derives from Remotion's Audiogram template. Review the
[Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
for applicable commercial terms.
