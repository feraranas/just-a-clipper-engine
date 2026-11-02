# Instagram upload recovery

`node scripts/publishing-recover.mjs --item ID` is an operator command (no npm script) for one item whose Instagram video upload failed. The default mode inspects: it reads the publishing ledger read-only, checks the approved MP4 hash, and makes Meta Graph **GET** calls (account check, container status). `--apply --expected-attempt ID --expected-container ID` takes the worker lock, repeats the checks and, only for a confirmed upload failure, moves the item back to `queued` with approval cleared. It never uploads or publishes. The old attempt stays visible in the approval UI history ([approval-ui](./approval-ui.md) `ui-history`). Design: `docs/features/instagram-controlled-recovery.md`.

## Sub-features

- `recover-guard` bad or duplicate flags, missing `--item`, relative `--db`/`--project-root`, `--apply` without both expected ids (or expected ids without `--apply`), or missing/invalid `INSTAGRAM_*` config → stdout `{"status":"stopped","reasonCode":"RECOVERY_CHECK_FAILED"}`, exit 1. Raw errors are never printed.
- `recover-schema` a ledger in which the publishing worker never ran has no `publishing_attempts` table; inspection also stops with `RECOVERY_CHECK_FAILED` (`Unsupported recovery schema` internally). A missing `--db` file is not created.
- `recover-inspect` returns `{"eligible":false,"reasonCode":...}` (exit 1) or `eligible: true` with `expected` ids (exit 0). Codes checked before any network call: `ACCOUNT_MISMATCH` (item missing, or its account is not `INSTAGRAM_ACCOUNT_ID`), `MISSING_ITEM_OR_ATTEMPT`, `CONTAINER_MISMATCH`, `PUBLICATION_EVIDENCE`, `PHASE_INELIGIBLE`, `APPROVAL_MISMATCH`. After the Meta GETs: `UPLOAD_FAILURE_UNCONFIRMED`, `STALE_SNAPSHOT`.
- `recover-apply` with matching ids → item `queued`, recovery audit row, one replacement attempt allowed after a fresh Approve + Schedule. A mismatch → `EXPECTED_IDENTIFIERS_MISMATCH`.

## How to get to it (user POV)

- `node scripts/publishing-recover.mjs --item "$ITEM_ID" --db "$PUBLISHING_DB" --project-root "$PROJECT_ROOT"`, then the same with `--apply --expected-attempt ... --expected-container ...` from fresh inspection output.

## Driving it with clipctl

Preconditions:

- Node >= 22.13. No real `INSTAGRAM_*` values in the environment and no `.env`. Use a scratch data root seeded through [audiogram-url](./audiogram-url.md).
- Block network calls from the CLI with a preload module, so a drive that unexpectedly reaches Meta fails loudly instead of calling it: `$STATE/no-net.mjs` containing `globalThis.fetch = async (u) => { console.error("NETWORK_BLOCKED " + u); process.exit(99); };`, and run `node --import $STATE/no-net.mjs scripts/publishing-recover.mjs ...`.

- **Guards.** With no `INSTAGRAM_*`, run the bad-argument cases above against `$STATE/data/instagram-publishing.sqlite`. Each prints `RECOVERY_CHECK_FAILED`, exit 1. The DB sha256 is unchanged and a nonexistent `--db` is not created.
- **Inspect (offline codes).** Queue an item with `INSTAGRAM_ACCOUNT_ID=111 AUDIOGRAM_DATA_ROOT=$STATE/data2 AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap node scripts/audiogram-url.mjs --url ...`, so the item's account is `111`, not `local-approval`. The first inspect gives `RECOVERY_CHECK_FAILED` (`recover-schema`). Harness scaffolding, not a user path: create the worker's empty tables with `node -e 'import("./scripts/publishing-execution.mjs").then(m=>m.createPublishingExecution(process.argv[1]).close())' $DB`. Then, with fake config `INSTAGRAM_PAGE_ACCESS_TOKEN=fake INSTAGRAM_PAGE_ID=222`: `INSTAGRAM_ACCOUNT_ID=111` → `MISSING_ITEM_OR_ATTEMPT`; `=999` or an unknown item → `ACCOUNT_MISMATCH`; `--apply --expected-attempt a --expected-container 1` → `MISSING_ITEM_OR_ATTEMPT`, and no `<db>.worker-lock` dir is left behind. None of these reach `NETWORK_BLOCKED`.

## Gotchas

- An eligible inspection, a real apply, and every code after the Meta GETs need a real failed upload attempt with a container id. That only exists after a real `publishing:run --live` failure and real credentials, so it is unverifiable by policy. The unit tests (`npm run test:publishing`, fakes and fixtures) are a developer signal only.
- Items queued without `INSTAGRAM_ACCOUNT_ID` get account `local-approval`. They always inspect as `ACCOUNT_MISMATCH`, because config account ids must be numeric.
- There is no recovery button in the approval UI. Recovery is CLI only.
