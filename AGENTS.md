## Agent-cost policy

  - Default to no subagents.
  - If delegation is explicitly required, use at most one subagent at a time.
  - Use `gpt-5.6-luna` with low reasoning effort.
  - Never use Astra/high reasoning unless I explicitly request it.
  - Prefer inline implementation and review for small tasks.
  - Do not dispatch a new reviewer when existing tests and a focused diff review are sufficient.
  - Keep delegated tasks bounded and report within 5 minutes when possible.

# Repository guidance

When introducing a new feature or meaningful behavioral change, invoke the
repository-local `feature-flow-diagrams` skill in DESIGN mode before writing
implementation code. Create or update a `docs/features/<feature>.md` note with
the intended flow, lifecycle, approval and external-side-effect boundaries,
failure/retry paths, and invariants.

After implementation and tests, invoke the same skill in RECONCILE mode before
declaring the work complete. Compare the note with the actual behavior,
document intentional deviations, and set the completion metadata to
`status: COMPLETE`, `design-reviewed: true`, and
`implementation-reconciled: true`. Run `npm run verify:feature-docs`; this is
the deterministic metadata/section gate used by both the local pre-push hook
and GitHub CI. Do not make pre-commit the front gate for this workflow.
