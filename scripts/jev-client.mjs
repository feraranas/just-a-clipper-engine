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
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: { transcript, candidates },
            model,
            questions,
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
