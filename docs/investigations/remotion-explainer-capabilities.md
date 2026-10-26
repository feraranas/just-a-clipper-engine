# Remotion capability investigation

Investigation date: 2026-10-11. This record separates observed behavior from proposals.

## Environment and evidence

Checkout: `/Users/kiwi/repositories/internal/remotion-projects/Audiograms`.
Branch: `main`. HEAD: `a0e63a1`. Installed Remotion: `4.0.525`.
Studio: `http://localhost:3000/AudiogramBasic`, opened through the Codex in-app browser.
Initial sandbox startup reported no available ports. Retrying with permission to bind a local server succeeded. This was an environment restriction.
No dependencies were installed. No provider calls, asset jobs, or publishing operations ran.

Sources: [WebMCP](https://www.remotion.dev/docs/ai/webmcp), [Sequence](https://www.remotion.dev/docs/sequence), and [renderMedia](https://www.remotion.dev/docs/renderer/render-media).
Context7 confirmed the documented tool stability warning and browser requirements.

## Live inventory and input contracts

The browser exposed 26 tools. Names have document-specific UUID suffixes.
Discover the current names rather than saving a suffix as a permanent identity.
The table uses semantic names. All live input schemas reject additional properties.
The browser exposes input schemas. It did not expose formal output schemas in this inventory.
Observed response shapes below are examples, not permanent output guarantees.

| Tool | Input contract | Evidence |
|---|---|---|
| get_compositions | Empty object | Executed |
| get_composition | Empty object | Executed |
| get_sequences | Empty object | Executed |
| get_current_error | Empty object | Executed |
| get_canvas_html | Empty object | Executed |
| get_outlines | Empty object | Executed |
| get_playback_state | Empty object | Executed |
| get_selection | Empty object | Executed |
| get_guides | Empty object | Executed |
| seek_to_frame | Required nonnegative integer frame | Executed with 90 and 0 |
| play | Empty object | Executed |
| pause | Empty object | Executed |
| mute | Empty object | Executed |
| unmute | Empty object | Executed |
| select_composition | Required string compositionName | Discovered, not executed |
| select_sequence | Required nonempty string sequenceId | Discovered, not executed |
| set_playback_rate | Required playbackRate from -4,-2,-1,-0.5,-0.25,0.25,0.5,1,1.5,2,4 | Discovered |
| set_timeline_zoom | Required number zoom between 0 and 1 | Discovered |
| add_guide | Required orientation horizontal/vertical and numeric position | Discovered |
| remove_guide | Required nonempty string guideId | Discovered |
| set_guides_visible | Required boolean visible | Discovered |
| install_package | Required packageName, optional exact version | Discovered, not executed |
| restart_studio | Empty object | Discovered, not executed |
| shut_down_studio | Empty object | Discovered, not executed |
| transcribe_asset | Optional assetPath, outputPath, model, language, task and Whisper settings | Discovered, not executed |
| separate_video_layers | Optional assetPath, baseOutputPath, foregroundOutputPath, model, audio and videoBitrate | Discovered, not executed |

Transcription settings: chunkLengthInSeconds 1..30, strideLengthInSeconds >=0,
doSample and forceFullSequences booleans, noRepeatNgramSize integer >=0,
repetitionPenalty and temperature >0, topK integer >=0, task transcribe/translate.
Defaults include small.en, en, chunk 30, stride 5, temperature 1, and topK 50.
Layer separation audio accepts base, foreground, both, or none. Model defaults
to ben2-base. Bitrate accepts a named quality or positive integer.
Execution readiness for these jobs remains unverified.

## Observed outputs

- Composition tree: Classic folder containing AudiogramBasic.
- Composition: 1080 by 1920, frame 0, but fps and durationInFrames were null.
- Sequences: four mounted entries: AbsoluteFill, Audio, Img, and Episode Title.
  Each had startFrame 0, endFrame 814, and durationInFrames 815.
- Outlines: three measurable objects with source locations and pixel geometry.
- Error: null. Selection: null. Guides: empty and hidden.
- Canvas HTML: 6954 characters, not truncated, with no canvas tag in this sampled frame.
- Seek: frame 90. Play: playing true. Later state: frame 131, playing true.
- Pause succeeded. Restored frame 0 and original unmuted state.
- Screenshot showed the Classic preview and timeline without an error overlay.

HTML cannot establish Canvas or WebGL pixel content. A screenshot remains
necessary for visual inspection. The observation above does not assess all frames.
The composition metadata tool's null fields prevent using it alone for timing validation.

## Documentation differences

The consulted documentation names remove_video_background. This installed
Studio instead exposed separate_video_layers, with two output paths and different
audio options. Do not substitute those contracts without a checked adapter.
No binary-search, graph-construction, or scene-authoring tool appeared in this inventory.

## Reuse decisions

| Need | Reuse or new work | Worker boundary |
|---|---|---|
| Inspect preview timing and layout | Verified Studio tools | Browser review |
| Draw and time scenes | Remotion components and Sequence APIs | Production renderer |
| Render a saved composition | Existing renderer integration | No open Studio tab required by proposed architecture |
| Audio alignment | Evaluate existing caption/audio utilities | Studio transcription is optional, not a mandatory worker dependency |
| Explain search or request flow | New sanctioned components | Checked scene plan to renderer |
| Discover explanatory blocks | Proposed project catalog and list_scene_blocks | Separate from Studio discovery |

Production without Studio is an architecture choice, not a newly executed render test here.
Asset-job discovery does not prove assets, models, packages, or hardware are ready.

## Proposed binary-search block contract

ID: binary-search. Version: 1. Status: proposed work.
Input: one to 64 ascending unique finite numeric values, one finite target,
scene duration in integer frames, and ordered cue frames within that duration.
Reject unsorted, duplicate, non-finite, empty, or oversized inputs.
Use inclusive low/high bounds and floor((low + high) / 2).
Require enough cues for the checked search trace, or report insufficient timing.

Actions: show-list, highlight-midpoint, narrow-range, update-count, show-result.
Counter values derive from comparison events. The model cannot supply an
independent count. Unknown actions and arbitrary executable expressions fail.
Repeated frame cues need a defined action order. Reject backwards or out-of-range cues.

Example: values [2,4,6,8,10,12,14], target 12.
First comparison: index 3, value 8. Keep inclusive range 4..6.
Second comparison: index 5, value 12. Result index 5, comparisons 2.
Missing targets end with not-found. The renderer must not highlight a false match.
Keep each value readable in its cell. Reject text overflow during preview checks.
Final pixel limits belong to the reviewed visual layout, not guessed constants.

The catalog returns contractVersion, catalogRevision, and supported blocks.
Each supported block includes blockId, blockVersion, purpose, inputSchema,
actionSchema, timingRules, and numericalRules.
Save catalogRevision and blockVersion with each scene plan.
Reject catalog references the renderer cannot resolve. Proposed blocks remain absent
from production discovery until their implementation and checks pass.

## Next slice brief

Source adapter can use fetchYoutubeTranscript(sourceUrl, {runCommand, tempRoot})
from scripts/youtube-transcript-core.mjs without calling a render pipeline.
It returns source, language, stable cue IDs, timestamps, and transcript identity.
It currently selects English captions and limits canonical text to 524288 bytes.
The next plan must specify an explicit English-only failure, not imply multilingual support.

Candidate drafting needs an LLM adapter with a checked structured response.
Jev's judgeCandidates({transcript, questions, candidates}) judges supplied candidates.
Its current transport bounds evidence using candidate time windows. Disjoint source
passages need an explicit projection that preserves every cited passage.
Do not reuse contiguous clip windows blindly for explanatory candidates.

Source revisions identify transcript hashes. Passage references combine source
revision and cue ID. Candidate sets and selections use exact revision hashes.
Keep three to five supported candidates where possible and allow fewer or none.
Selection requires expected job revision and request ID. Repeated identical requests
return their prior outcome. Conflicting reuse or stale selection fails.
Persist evidence and selection outside the checkout before reporting success.
The next plan must include leases, uncertain paid requests, restart recovery,
credential preflight, and safe user-visible errors before implementation starts.

## Execution rulings and limitations

Used inline review rather than a separate reviewer because repository policy
and the approved plan require no subagents. No product code changed.
No throwaway composition was built: the approved plan limits this phase to
investigation and contracts. A binary-search render remains future verification.
Complete input schemas were inspected in the live browser. The table records
normalized contracts; live handles must be rediscovered when the document changes.
