# Render audiogram template

The `AudiogramBasic` Remotion composition turns an audio clip, cover image, captions and title into a 1080×1920 vertical MP4 with a waveform and word-by-word captions.

## Sub-features

- `render-video` produces 180 frames at 30 fps, 1080×1920, h264.
- `render-audio` muxes the clip audio (AAC stereo 48 kHz).
- `render-layout` shows the cover, the title, a progressing waveform and highlighted caption words.

## How to get to it (user POV)

- README "Select a video template" / `tests/fixtures/classic-v1/README.md`: `remotion render AudiogramBasic <out.mp4> --props=<props.json> --frames=0-179 --concurrency=1 --codec=h264`.
- Indirectly through `audiogram:url` / `youtube:inbox` renders.

## Driving it with clipctl

Preconditions:

- Launched (fixture staged), doctor `OK`.

- **Render.** Run `clipctl journey render-classic-fixture`. Exit `0`; render log ends `+ .../candidate.mp4 516.2 kB`.
- **Shape.** `checks.json` all `true`; `ffprobe.json` shows h264 1080×1920 `30/1` 180 frames and AAC 48000 Hz 2 ch, duration ≈ 6.06 s.
- **Layout.** `frame-90.png` shows the `SYNTHETIC FIXTURE` cover, the long title, the waveform half white / half grey, and caption `Each frame should remain identical after` with `Each` highlighted.

## Gotchas

- Frame-exact parity needs the local-only baseline MP4; not checked.
- Without `CHROME_PATH`/system Chrome, Remotion downloads Chrome Headless Shell (network) on first render.
- Proved on Node 20.19.2 and Node 22.23.4; README requires Node 22.
