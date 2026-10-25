# Classic V1 neutral sample

This fixture uses original demonstration text and SVG artwork. It contains no
user clips or third-party media. `sample.json` sets the title, sentences, local
macOS voice, and speaking rate.

Run `npm run samples:render` on macOS with the Samantha voice, FFmpeg, ffprobe,
and the repository dependencies installed. The command uses the existing
`AudiogramBasic` composition and the preserved Classic defaults. It does not
call a narration provider or create a processing job.

The command generates each sentence separately. It measures each audio duration
and uses those boundaries for captions. Word times are proportional estimates
within each measured sentence, not speech-alignment results. It joins the sentences, renders
the video, checks its media properties, and extracts a poster at two seconds.
The accepted video must be 10–15 seconds, 1080 × 1920, H.264, with audio.

Assets go into `<AUDIOGRAM_DATA_ROOT>/template-samples` by default. Set
`AUDIOGRAM_SAMPLE_ROOT` to an absolute location outside all Git checkouts to
override it. Each generation keeps a manifest, source audio, captions, props,
MP4, and poster in a new revision directory. Voice and encoder versions can
change output bytes. The fixture reproduces content and layout, not a fixed hash.

The registry changes only after rendering and media validation succeed. Existing
revisions remain available locally. A replacement clears the old external video
URL so that the page cannot pair new artwork with an old video. Stop and restart
the sample server after registry changes.

A render lock prevents concurrent writers. If a process is killed and leaves
`.render-lock`, first confirm no sample render process is running. Then remove
that empty lock directory and retry. Failed runs never overwrite accepted files.

Review the generated video before public use. The sample server serves the page
and JPEG poster only. The MP4 stays local until a video host is selected.
