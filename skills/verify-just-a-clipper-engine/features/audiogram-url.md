# Direct-URL pipeline

`npm run audiogram:url -- --url <youtube-url>` selects clip moments for one public video, downloads only those audio intervals, renders them and adds them to the local approval queue. It prints one versioned JSON result on stdout (`complete`, `no_clips` or `failed`, exit 0); usage errors exit 2.

## Sub-features

- `url-usage` exits 2 with the usage line when `--url` is missing.
- `url-heatmap` `AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap` selects from YouTube Most Replayed (no LLM).
- `url-transcript-llm` the default selector, which needs `AUDIOGRAM_LLM_PROVIDER` and credentials.
- `url-queue` completed renders appear in the approval queue.
- `url-failed` metadata/download failures still exit 0 with `status: failed` and a `failures` list.
- `url-retry` `--retry-failed-renders` re-renders failed clips.

## How to get to it (user POV)

- `npm run audiogram:url -- --url 'https://www.youtube.com/watch?v=VIDEO_ID' [--template classic --template-version 1 --variation default]`

## Driving it with clipctl

Preconditions:

- Node >= 22.13; yt-dlp, ffmpeg, ffprobe on PATH; `AUDIOGRAM_DATA_ROOT=$STATE/data` (absolute); a public video with a Most Replayed heatmap (`dQw4w9WgXcQ` works).

- **Usage.** Run `node scripts/audiogram-url.mjs`. Exit `2`; stderr `--url is required.` plus usage.
- **Heatmap run.** Run `AUDIOGRAM_DATA_ROOT=$STATE/data AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap node scripts/audiogram-url.mjs --url <url>` (about 10–30 s). stdout JSON `status: complete` with `artifactPaths` relative to the data root: `$STATE/data/artifacts/<hash>/<hash>/video.mp4` plus `video.manifest.json`. ffprobe: h264 1080×1920 + AAC. `/api/items` on the approval UI lists one `queued` item for the video.

## Gotchas

- The default selector calls an LLM (paid API or ChatGPT OAuth). Do not use it for verification without approval.
- `AUDIOGRAM_MAX_CLIPS` defaults to 1 and a heatmap clip is one Most Replayed marker, so the clip can be very short (about 2 s for `dQw4w9WgXcQ`, interval 0–2.14 s).
- YouTube may answer `Sign in to confirm you're not a bot`; the run then returns `status: failed`, stage `metadata`. Retry with another video or later; it is not a product failure.
- The run leaves unkeyed intermediates in the checkout: `public/generated/<videoId>/` and `out/treatments/audiogram-basic/1/<videoId>/` (both gitignored, shared across runs). Delete them during cleanup.
