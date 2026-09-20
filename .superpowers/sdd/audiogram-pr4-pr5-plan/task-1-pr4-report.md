# Task 1 PR #4 Report: Explicit SQLite Schema Version 1

## RED evidence

Before editing `scripts/audiogram-ledger.mjs`, ran:

```console
node --test --test-name-pattern="schema version|unversioned|too-new|ambiguous" scripts/audiogram-ledger.test.mjs
```

Result: exit 1; 7 tests run, 0 passed, 7 failed. The failures matched the
missing requirements: `AUDIOGRAM_SCHEMA_VERSION` and `getSchemaVersion()` were
absent, while too-new, mixed, and malformed databases opened instead of being
rejected.

## Changes

- Exported `AUDIOGRAM_SCHEMA_VERSION = 1` and exposed
  `ledger.getSchemaVersion()`.
- Added explicit `PRAGMA user_version` reading and fail-closed rejection of
  unsupported versions before initialization writes.
- Classified version-0 ledgers as fresh, legacy-only, generic-only, or
  ambiguous/incomplete inside `BEGIN IMMEDIATE`.
- Preserved the existing legacy row mappings and current-generic adoption,
  including adding only the two historical optional `clip_assets` columns.
- Added schema-v1 table/column validation, transactional version stamping, and
  rollback on migration or validation failure.
- Added coverage for fresh, legacy, exact generic, historical generic,
  too-new, mixed, and malformed databases.

## GREEN and full-ledger evidence

```console
node --test --test-name-pattern="schema version|unversioned|too-new|ambiguous" scripts/audiogram-ledger.test.mjs
# exit 0; 7 passed, 0 failed

node --test scripts/audiogram-ledger.test.mjs
# exit 0; 12 passed, 0 failed

npm run test:youtube
# exit 0; 42 passed, 0 failed

npx prettier --check scripts/audiogram-ledger.mjs scripts/audiogram-ledger.test.mjs
# exit 0; all matched files use Prettier code style

git diff --check
# exit 0
```

## Commit

Implementation commit: `1f5a943` (`feat: version audiogram ledger schema`)

## Concerns

- Node `v22.23.2` still prints its standard experimental warning for
  `node:sqlite`; no test or behavior failure accompanied the warning.
- This task intentionally excludes PR #4's later artifact-path/publication work,
  PR #5's operational lock, and transcript selection.
