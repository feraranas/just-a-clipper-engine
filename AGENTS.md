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
repository-local `feature-flow-diagrams` skill
(`skills/feature-flow-diagrams/SKILL.md`, linked from `.claude/skills/`) in DESIGN mode before writing
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


## Feature document stages and PR readiness

Commit and push DESIGN and IN_PROGRESS notes with honest metadata. This does
not authorize implementation or claim completion. Keep the note in docs/features.
DESIGN may use design-reviewed false while awaiting review. Set it true after
review and before implementation. IN_PROGRESS requires design-reviewed true.
Both unfinished stages require implementation-reconciled false.
COMPLETE requires both review flags true after verification and reconciliation.
All stages retain the required sections; use an explicit pending reconciliation
statement while unfinished. The local and CI document checks validate these rules.

Documentation-only PRs may merge with unfinished notes. Other PRs must include
one plain line in their body: `Feature-docs: docs/features/<feature>.md`.
Use commas to name multiple notes. Readiness requires each named note COMPLETE;
unrelated unfinished notes do not block it. Keep unfinished implementation PRs
in draft. For maintenance with no feature behavior, use `Feature-docs: none`
and a `Feature-docs-reason:` line. Reviewers must verify this exemption and
whether the declared notes cover the change. The check cannot infer scope.
Only docs/**/*.md, root README.md and root AGENTS.md count as documentation-only.
The pr-readiness check is separate from document validation; branch protection
must require it to enforce this merge rule. Never mark a note complete or bypass
hooks merely to save unfinished work on GitHub.

## Verification

To prove the audiogram renderer works end to end, use the verification skill at `skills/verify-just-a-clipper-engine/SKILL.md` (also linked from `.cursor/skills/` and `.claude/skills/`):

```bash
export RUN_ID=$(date +%s)
skills/verify-just-a-clipper-engine/scripts/clipctl launch
skills/verify-just-a-clipper-engine/scripts/clipctl doctor
skills/verify-just-a-clipper-engine/scripts/clipctl journey render-classic-fixture
skills/verify-just-a-clipper-engine/scripts/clipctl cleanup
```

It renders the synthetic `tests/fixtures/classic-v1` fixture offline with no OAuth, LLM, YouTube or Instagram calls. Never run `publishing:run --live` for verification. Feature recipes, including what is not yet proved, are in `skills/verify-just-a-clipper-engine/features/`.
