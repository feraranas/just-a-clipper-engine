# Direct-URL pipeline

`npm run audiogram:url -- --url <youtube-url>` selects clip moments for one public video, downloads only those audio intervals, renders them and adds them to the local approval queue. It prints one versioned JSON result on stdout (`complete`, `no_clips` or `failed`, exit 0); usage errors exit 2.

## Sub-features

- `url-usage` exits 2 with the usage line when `--url` is missing.
- `url-heatmap` `AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap` selects from YouTube Most Replayed (no LLM).
- `url-transcript-llm` the default selector, which needs `AUDIOGRAM_LLM_PROVIDER` and credentials.
- `url-queue` completed renders appear in the approval queue.
- `url-retry` `--retry-failed-renders` re-renders failed clips.

## How to get to it (user POV)

- `npm run audiogram:url -- --url 'https://www.youtube.com/watch?v=VIDEO_ID' [--template classic --template-version 1 --variation default]`

## Driving it with clipctl

Preconditions:

- yt-dlp, ffmpeg, ffprobe on PATH; `AUDIOGRAM_DATA_ROOT=$STATE/data` (absolute); a public video with a Most Replayed heatmap.

- **Usage.** Run `node scripts/audiogram-url.mjs`. Exit `2`; stderr `--url is required.` plus usage.
- **Heatmap run.** Run `AUDIOGRAM_DATA_ROOT=$STATE/data AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap npm run audiogram:url -- --url <url>`. stdout JSON `status: complete`; MP4s under `out/treatments/...`; the queue lists them.

## Gotchas

- Not proved. The heatmap run reads from YouTube (no writes, no paid API) but depends on a live video having heatmap data.
- The default selector calls an LLM (paid API or ChatGPT OAuth). Do not use it for verification without approval.
- `public/generated/` and `out/` are gitignored but shared across checkouts; key outputs by run.
