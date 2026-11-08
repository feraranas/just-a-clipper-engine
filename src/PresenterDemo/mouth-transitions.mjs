// Atlas cells are a visual palette, not additional recognized phonemes.
export const mouthPoses = Object.freeze({
  X: { target: 0, enter: 17, leave: 0 },
  A: { target: 1, enter: 1, leave: 1 },
  B: { target: 2, enter: 9, leave: 14 },
  C: { target: 3, enter: 10, leave: 19 },
  D: { target: 4, enter: 11, leave: 10 },
  E: { target: 5, enter: 13, leave: 12 },
  F: { target: 6, enter: 12, leave: 18 },
  G: { target: 7, enter: 15, leave: 15 },
  H: { target: 8, enter: 16, leave: 16 },
});

export function mouthPoseAt(cues, frame, fps) {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0)
    throw new Error("Mouth animation requires a finite frame and positive fps");
  const seconds = frame / fps;
  const index = cues.findIndex((c) => seconds >= c.start && seconds < c.end);
  if (index < 0) return 0;
  const cue = cues[index];
  const pose = mouthPoses[cue.value];
  if (!pose) throw new Error("Unsupported mouth cue");
  const firstFrame = Math.ceil(cue.start * fps);
  const endFrame = Math.ceil(cue.end * fps);
  const length = endFrame - firstFrame;
  // Never dilute a short consonant or delay an M/B/P closure.
  if (length < 5 || cue.value === "A") return pose.target;
  const age = frame - firstFrame;
  const remaining = endFrame - 1 - frame;
  const entryFrames = Math.min(2, Math.floor(length / 4));
  if (age < entryFrames && cues[index - 1]?.value !== cue.value)
    return pose.enter;
  if (remaining < 1 && cues[index + 1]?.value !== cue.value) return pose.leave;
  return pose.target;
}
