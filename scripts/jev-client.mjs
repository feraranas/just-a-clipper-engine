export const createJevClient = ({ judgeCandidates }) => {
  if (typeof judgeCandidates !== "function") throw new Error("judgeCandidates transport is required");
  return Object.freeze({ judgeCandidates });
};

export const createHttpJevClient = ({
  endpoint,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  model = "jev-latest",
}) => {
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint))
    throw new Error("Jev endpoint must be an HTTPS URL");
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error("Jev API key is required");
  if (typeof fetchImpl !== "function") throw new Error("Jev fetch transport is required");
  return createJevClient({
    async judgeCandidates({ transcript, questions, candidates }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const candidateWindows = Array.isArray(candidates) ? candidates.filter((candidate) => Number.isFinite(candidate.startMs) && Number.isFinite(candidate.endMs)).map((candidate) => ({ startMs: candidate.startMs - 30_000, endMs: candidate.endMs + 30_000 })) : [];
        const boundedCues = Array.isArray(transcript?.cues) && candidateWindows.length > 0
          ? transcript.cues.filter((cue) => candidateWindows.some((window) => cue.endMs > window.startMs && cue.startMs < window.endMs)).slice(0, 1_200)
          : transcript?.cues;
        const boundedTranscript = transcript && Array.isArray(transcript.cues) ? { ...transcript, cues: boundedCues } : transcript;
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: { transcript: boundedTranscript, candidates },
            model,
            questions: Array.isArray(questions)
              ? Object.fromEntries(questions.map((question) => [question.id, question]))
              : questions,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || typeof payload.answers !== "object" || Array.isArray(payload.answers))
          throw new Error("Jev response did not contain answers");
        return payload.answers;
      } finally {
        clearTimeout(timer);
      }
    },
  });
};
