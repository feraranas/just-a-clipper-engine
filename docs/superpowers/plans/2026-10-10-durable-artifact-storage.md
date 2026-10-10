# Durable artifact storage implementation

1. Add a shared absolute storage configuration with checked overrides and legacy alias handling.
2. Add a content-addressed bundle store and resolver with containment and integrity checks.
3. Promote render output before success; integrate all pipeline, helper, preview and publishing consumers.
4. Add an explicit verified migration for historical publishing and processing ledger references.
5. Show actionable missing-preview errors and document storage paths and recovery commands.
6. Test cross-checkout playback after producer removal, failure paths and unchanged approval metadata.
7. Reconcile the feature document, run verification, commit and prepare a reviewable PR.

User authorization: proceed with the previously presented durable-storage design.
Execution: inline, without subagents. Live publication is outside scope.


Execution record: steps 1–6 implemented. Full pipeline tests 381/381, helper/UI
46/46, lint and TypeScript passed. Real Classic decoded output matched the
preserved baseline. Live migration was previewed read-only; five older references
remain unresolved. Feature reconciliation records the supported scope and limits.
