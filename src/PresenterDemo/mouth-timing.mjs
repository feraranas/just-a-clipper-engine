export function validateMouthCues(cues, duration) {
  if (
    !Array.isArray(cues) ||
    !cues.length ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw Error("Invalid mouth timing");
  let previous = 0;
  for (const cue of cues) {
    if (
      !/^[A-HX]$/.test(cue.value) ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < previous ||
      cue.end <= cue.start ||
      cue.end > duration + 0.1
    )
      throw Error("Invalid mouth cue");
    previous = cue.end;
  }
  return cues;
}
export function mouthAt(cues, seconds) {
  return cues.find((c) => seconds >= c.start && seconds < c.end)?.value ?? "X";
}
