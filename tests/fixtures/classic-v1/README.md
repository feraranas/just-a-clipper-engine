# Classic V1 synthetic fixture

All content is synthetic. The fixture contains six seconds of 16 kHz mono PCM audio, a generated thumbnail and fixed caption times. The audio is a 440 Hz sine wave with amplitude 5000. Copy audio.wav, thumbnail.svg and captions.json to public/generated/classic-regression before rendering with props.json.

## Render and compare

Run these commands from the repository root after copying the three assets:

```sh
mkdir -p public/generated/classic-regression out/classic-regression
cp tests/fixtures/classic-v1/audio.wav tests/fixtures/classic-v1/thumbnail.svg tests/fixtures/classic-v1/captions.json public/generated/classic-regression/
./node_modules/.bin/remotion render AudiogramBasic out/classic-regression/candidate.mp4 --props=tests/fixtures/classic-v1/props.json --frames=0-179 --concurrency=1 --codec=h264
node scripts/verify-classic-parity.mjs --baseline out/classic-regression/baseline.mp4 --candidate out/classic-regression/candidate.mp4 --manifest tests/fixtures/classic-v1/baseline-manifest.json
```

The original baseline MP4 and font copies remain local under `out/classic-regression/`.
The committed manifest records their hashes and the exact source revision.
A fresh checkout needs those files or a new baseline render from the recorded revision.
Do not replace the reference with a candidate render.
Font URLs in the manifest identify the pinned IBM Plex Sans v23 files.
Download each file to its recorded path and check its SHA-256 before comparison.
The font source module uses those same versioned URLs. No product font-loading behavior changed.

The checker compares every decoded frame, audio hash, dimensions, frame rate, sample rate and channel count.
It also checks fixture, dependency and baseline hashes.
The fixture contains generated test content, not a user's source video.
