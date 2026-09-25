const selectors = ["youtube-heatmap", "transcript-llm", "question-analysis"].map((id) =>
  Object.freeze({ id, version: "1" }),
);

export const selectorRegistry = Object.freeze({
  get(id, version = "1") {
    const selector = selectors.find(
      (entry) => entry.id === id && entry.version === version,
    );
    if (!selector) throw new Error("Unsupported clip selector or version");
    return selector;
  },
});
