# Local presenter comparison

Two experimental compositions share the approved script, local Samantha narration,
seven scene timings, captions, and diagrams. PresenterTalking adds an amplitude-driven
mouth overlay. It is not phoneme-accurate lip synchronization. PresenterStatic
uses the supplied reference without animated mouth changes.

The screenshot is a presenter reference, not evidence for the video's topic.
It is copied unchanged and cropped by layout. The script is in
`scripts/prepare-presenter-demo.py`. Local screenshot/audio files stay untracked.

Prepare from macOS with say and ffmpeg installed:

```sh
python3 scripts/prepare-presenter-demo.py --reference /absolute/path/to/reference.png
```

The crop expects the specific 526 by 942 reference supplied for this comparison.
It is not a general image-import facility. Preview PresenterStatic or PresenterTalking
in Studio. Render with the usual Remotion CLI and choose the composition ID.
The compositions are not entries in the production template catalog.

Timing uses measured generated audio. The amplitude table controls mouth opening
at each frame. Audio amplitude does not establish which phoneme is being spoken.
A later accurate lip-sync comparison needs phoneme timing and proper mouth artwork.

## Liam close-up

LiamLipSyncCloseup is a ten-second review sample using accepted ElevenLabs
audio and Rhubarb sound-based mouth cues. It uses nine SVG mouth drawings.
The enlarged reference remains low resolution. This is a prototype for
checking speech timing, not a production-ready character rig.

Paid generation uses scripts/elevenlabs-narration.mjs. It saves a request
checkpoint before contacting the provider and refuses to repeat that request
in the same output directory. Never delete a checkpoint to force a retry
before checking the saved response and outcome.

Local cue preparation never generates paid audio:

```sh
node scripts/prepare-liam-lipsync.mjs --audio-dir /absolute/path/to/accepted-audio --rhubarb /absolute/path/to/rhubarb
```

The command checks the saved audio hash, converts it to WAV, supplies the
approved text to Rhubarb, checks mouth-cue ordering, and prepares caption
words from ElevenLabs character timing. It saves source metadata in
src/PresenterDemo/liam-cues.json. It does not modify the earlier Samantha assets.
