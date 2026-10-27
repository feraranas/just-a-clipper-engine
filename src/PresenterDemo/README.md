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
