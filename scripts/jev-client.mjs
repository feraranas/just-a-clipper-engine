export const createJevClient = ({ judgeCandidates }) => {
  if (typeof judgeCandidates !== "function") throw new Error("judgeCandidates transport is required");
  return Object.freeze({ judgeCandidates });
};
