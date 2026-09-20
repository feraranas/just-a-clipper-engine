import {
  buildTranscriptZodSchema,
  TRANSCRIPT_PROMPT,
} from "./clip-selection-contract.mjs";
import { canonicalJson, sha256Canonical } from "./canonical-json.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const validateTranscript = (transcript) => {
  if (
    !transcript ||
    typeof transcript.source !== "string" ||
    typeof transcript.language !== "string" ||
    !Array.isArray(transcript.cues) ||
    transcript.cues.length === 0
  )
    throw new Error("Invalid transcript envelope");
  const byId = new Map();
  transcript.cues.forEach((cue, index) => {
    if (
      !cue ||
      typeof cue.id !== "string" ||
      !/^c\d{6}$/.test(cue.id) ||
      byId.has(cue.id) ||
      !Number.isFinite(cue.startMs) ||
      !Number.isFinite(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs ||
      typeof cue.text !== "string"
    )
      throw new Error(`Invalid transcript cue at index ${index}`);
    byId.set(cue.id, { cue, index });
  });
  return {
    byId,
    transcriptEndMs: Math.max(...transcript.cues.map((cue) => cue.endMs)),
  };
};

export const buildTranscriptPrompt = (transcript) => {
  validateTranscript(transcript);
  const canonicalTranscript = {
    source: transcript.source,
    language: transcript.language,
    cues: transcript.cues,
  };
  return {
    instructions: TRANSCRIPT_PROMPT,
    input: canonicalJson(canonicalTranscript),
    templateSha256: sha256Canonical(TRANSCRIPT_PROMPT),
    transcriptSha256: computeTranscriptIdentity(canonicalTranscript).sha256,
  };
};

export const deriveClipSelections = (parsed, transcript, recipe) => {
  const count = recipe?.desiredClipCount;
  const validated = buildTranscriptZodSchema(count).parse(parsed);
  const { byId, transcriptEndMs } = validateTranscript(transcript);
  const limits = recipe?.limits;
  if (!limits) throw new Error("Transcript recipe limits are required");

  const ranks = new Set(validated.clips.map((clip) => clip.rank));
  if (
    ranks.size !== count ||
    !Array.from({ length: count }, (_, i) => i + 1).every((rank) =>
      ranks.has(rank),
    )
  )
    throw new Error("Clip ranks must be exactly 1 through the requested count");
  const ideaKeys = new Set();
  const spans = new Set();
  const results = validated.clips.map((clip) => {
    const names = [
      "startCueId",
      "contextCueId",
      "insightCueId",
      "payoffCueId",
      "endCueId",
    ];
    const located = names.map((name) => {
      const found = byId.get(clip[name]);
      if (!found) throw new Error(`Unknown transcript cue ID: ${clip[name]}`);
      return found;
    });
    const [start, context, insight, payoff, end] = located;
    if (
      !(
        start.index <= context.index &&
        context.index < insight.index &&
        insight.index < payoff.index &&
        payoff.index <= end.index
      )
    )
      throw new Error(
        "Clip evidence must satisfy start <= context < insight < payoff <= end",
      );
    if (ideaKeys.has(clip.ideaKey))
      throw new Error("Clip idea keys must be unique");
    ideaKeys.add(clip.ideaKey);
    const span = `${clip.startCueId}:${clip.endCueId}`;
    if (spans.has(span)) throw new Error("Clip cue spans must be unique");
    spans.add(span);

    const startMs = Math.max(0, start.cue.startMs - limits.leadingPaddingMs);
    const endMs = Math.min(
      transcriptEndMs,
      end.cue.endMs + limits.trailingPaddingMs,
    );
    const durationMs = endMs - startMs;
    if (durationMs < limits.minimumClipMs || durationMs > limits.maximumClipMs)
      throw new Error("Derived clip duration is outside the configured limits");
    return { ...clip, startMs, endMs };
  });

  const chronological = [...results].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  );
  for (let index = 1; index < chronological.length; index++) {
    const separation =
      chronological[index].startMs - chronological[index - 1].endMs;
    if (separation < limits.minimumSeparationMs)
      throw new Error("Derived clips overlap or violate minimum separation");
  }
  return results.sort((left, right) => left.rank - right.rank);
};
