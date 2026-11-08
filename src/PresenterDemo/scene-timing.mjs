export function deriveSceneTiming(baseline, words, duration, fps = 24) {
  if (
    !Array.isArray(baseline) ||
    !baseline.length ||
    !Array.isArray(words) ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw Error("Invalid scene timing input");
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
  let cursor = 0;
  const segments = [];
  for (const scene of baseline) {
    const tokens = scene.text.split(/\s+/).filter(Boolean);
    const selected = words.slice(cursor, cursor + tokens.length);
    if (
      !tokens.length ||
      tokens.length !== selected.length ||
      tokens.some((t, i) => clean(t) !== clean(selected[i].text)) ||
      selected.some(
        (w) =>
          !Number.isFinite(w.start) ||
          !Number.isFinite(w.end) ||
          w.end < w.start ||
          w.start < 0 ||
          w.end > duration + 0.1,
      )
    )
      throw Error("Approved script and narration do not match");
    segments.push({
      text: scene.text,
      start: segments.length ? selected[0].start : 0,
      end: selected.at(-1).end,
    });
    cursor += tokens.length;
  }
  if (cursor !== words.length) throw Error("Narration has unmatched words");
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i + 1].start <= segments[i].start)
      throw Error("Invalid scene sequence");
    segments[i].end = segments[i + 1].start;
  }
  segments.at(-1).end = duration;
  return { duration, fps, segments };
}
