import { projectStageFact } from "./mcp-event-contract.mjs";

export function createStageEventSink({
  store,
  job,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let chain = Promise.resolve();
  let state = "complete";
  let closed = false;
  const record = (normalized) => {
    if (closed) {
      state = "incomplete";
      return Promise.resolve({ persisted: false });
    }
    const operation = async () => {
      let fact;
      try {
        fact = projectStageFact({
          job,
          normalized,
          sourceId: normalized.sourceId,
          stageInstanceId: normalized.stageInstanceId,
          stageAttempt: normalized.stageAttempt,
        });
      } catch {
        state = "incomplete";
        return { persisted: false };
      }
      if (fact === null) return { persisted: false };
      // Each attempt is a complete short SQL transaction. Never hold a lock across waits.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { event } = store.appendProgress({
            jobId: job.jobId,
            sourceId: fact.source_id,
            fact,
          });
          return {
            persisted: true,
            eventId: event.eventId,
            sequence: event.data.sequence,
          };
        } catch {
          if (attempt < 2) {
            try {
              await sleep(attempt === 0 ? 50 : 100);
            } catch {
              state = "incomplete";
              return { persisted: false };
            }
          }
        }
      }
      state = "incomplete";
      return { persisted: false };
    };
    chain = chain.then(operation, operation);
    return chain;
  };
  return Object.freeze({
    record,
    flush: () => chain,
    captureState: () => state,
    close: async () => {
      closed = true;
      await chain;
    },
  });
}
