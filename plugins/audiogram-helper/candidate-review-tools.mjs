import { z } from "zod";
export function registerCandidateReviewTools(server, runner) {
  const tools = [
    [
      "prepare_candidate_review",
      "Prepare topic candidates from one YouTube video using the configured LLM and Jev. Returns saved progress. No video is rendered. For an explicit retry, use a new requestId.",
      { url: z.string().min(1).max(2048), requestId: z.string().uuid() },
      (args) => runner.prepare(args),
    ],
    [
      "retry_candidate_review",
      "Only after explicit user approval, retry a timed-out candidate drafting attempt using its saved transcript and a new request ID. This may incur costs. Get the original review first.",
      { reviewId: z.string().uuid(), requestId: z.string().uuid() },
      (args) => runner.retry(args),
    ],
    [
      "get_candidate_review",
      "Read saved topic candidates, evidence, question definitions, raw Jev answers, and progress. Does not repeat processing.",
      { reviewId: z.string().uuid() },
      (args) => runner.get(args),
    ],
    [
      "select_candidate_review",
      "Save the topic the user explicitly chose from this exact review. Does not write a script or render a video.",
      {
        reviewId: z.string().uuid(),
        reviewHash: z.string().min(1).max(100),
        candidateId: z.string().min(1).max(120),
      },
      (args) => runner.select(args),
    ],
  ];
  for (const [name, description, shape, call] of tools)
    server.registerTool(
      name,
      { description, inputSchema: z.strictObject(shape) },
      async (args) => {
        try {
          const result = await call(args);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { contractVersion: 1, ...result },
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Candidate review could not complete this action. Check configuration, review identity, and saved progress.",
              },
            ],
          };
        }
      },
    );
}
