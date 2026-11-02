// Keep tool responses, CLI result validation, and event projection in agreement.
export const JOB_STAGES = Object.freeze([
  "worker",
  "intake",
  "metadata",
  "setup",
  "transcript",
  "selection",
  "jev",
  "assets",
  "render",
  "artifact_verification",
]);
