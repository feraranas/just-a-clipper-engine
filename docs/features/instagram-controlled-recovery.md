---
feature: instagram-controlled-recovery
status: COMPLETE
design-reviewed: true
implementation-reconciled: true
---

# Controlled Instagram publishing recovery

The user approved this design in chat on 2026-10-13. Implementation and
reconciliation are complete.

## Changed / unchanged

Add explicit recovery for confirmed video-upload failures and durable dashboard
failure history. Investigate uncertain container creation without assuming Meta
supports discovery of a container whose ID was never received. Keep the existing
approval button, separate one-shot worker, account checks, artifact integrity
checks, and conservative publication handling. Do not add a scheduler or a
dashboard recovery action in this slice.

## Mermaid flowchart

```mermaid
flowchart TD
  A[Operator inspects exact item and attempt] --> B[Read ledger and fresh Meta status]
  B --> C{Confirmed eligible upload failure?}
  C -->|No or ambiguous| D[Stop and explain evidence]
  C -->|Yes| E[Explicit apply: lock and repeat checks]
  E --> F[Atomic ledger recovery and audit record]
  F --> G[Queued with previous failure visible]
  G --> H[Human approves and schedules again]
  H --> I[Separately invoked worker verifies account and MP4 hash]
  I --> J[Create new container and upload MP4]
  J --> K[Poll processing then publish when ready]
```

## Lifecycle/state diagram

```mermaid
stateDiagram-v2
  queued --> approved: Human approval
  approved --> uploading: Due item claimed
  uploading --> container_created: Container ID received
  uploading --> unknown: Creation outcome uncertain
  container_created --> processing: Upload accepted
  container_created --> failed: Confirmed upload failure
  failed --> queued: Explicit eligible recovery; approval cleared
  processing --> published: Ready then publish confirmed
  processing --> unknown: Publish outcome uncertain
```

The existing item may still be container_created with an upload_requested attempt.
Recovery must also handle this legacy representation when fresh evidence proves
the eligible failure; do not require running the publishing worker to classify it.

## Human approval and external-side-effect boundaries

Inspection reads existing data, validates the artifact, and issues Meta GETs only.
It must not run schema migrations or create an empty database. Apply takes the
existing worker lock, repeats checks, then changes local state only. Preserve
the failed attempt, old container, sanitized evidence, and recovery audit record.
Clear active container fields, approval snapshots, and scheduling atomically.
The item returns to queued, never directly to approved.

Fresh Approve + Schedule authorizes a later worker invocation to create a new
container, upload, wait for processing, and publish. No second approval is
required between processing and publication. No live recovery or publication
is authorized by passing implementation tests.

## Failure and retry paths

### Provider research (2026-10-13)

Context7's official Instagram Platform documentation describes status GETs
using a known container ID and resumable upload offsets using that container.
No documented idempotency key or reliable lookup without the creation-response
ID was found. This is a research limit, not proof that Meta has no such API.
Creation without an ID therefore stays unknown and cannot be recovered here.
Sources: [content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing),
[resumable uploads](https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads),
[container reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container).
The direct official page fetch was unavailable; Context7 retrieved these official
sources. EXPIRED means unpublished after 24 hours; it is not upload-failure proof.
FINISHED means ready and PUBLISHED means published, so neither qualifies even if
contradictory upload details say error. Upload error with processing not started
or also failed, plus ERROR or IN_PROGRESS, qualifies alongside local
pre-publication proof. Processing-only errors do not qualify. A fixture models
the historical sanitized upload+processing error, zero byte counts and code
1363008; those old observations do not establish the target's current state.

- Investigate official Meta documentation for reconciliation or idempotency when
  container creation times out without an ID. Record sources and limitations.
  If no reliable documented mechanism is found, keep creation outcome unknown
  and block automatic replacement. Absence from a listing is not proof of failure.
- Scope initial recovery to confirmed upload-phase failure before publish intent.
  Pending, ready, published, processing-only failure, inaccessible containers,
  missing evidence, and contradictory status do not qualify.
- Require exact item, latest attempt, container, account, approved caption, and
  artifact hash. Recheck state after asynchronous reads and inside the transaction.
- Never blindly retry create, upload, or publish requests. Never recover an attempt
  that requested publication or has a recorded media ID.
- Roll back the complete local transition if audit or diagnostic storage fails.
- Reject duplicate apply operations and stale expected attempt/container values.

## Dashboard history

Show current state separately from previous attempt outcome. A requeued item can
show "Queued — awaiting approval" and "Previous attempt: Video upload failed".
Include attempt time, sanitized failure code, and recovery status. Preserve this
history after reapproval and subsequent attempts. Distinguish upload failure,
creation outcome unknown, still processing, and publication outcome unknown.
Do not infer failure from elapsed time. Never expose tokens, upload URLs, or raw
provider messages. Recovery remains an operator command in this slice.

## Invariants

- An explicit recovery action targets one item and its latest identified attempt.
- Recovery never publishes, uploads, creates containers, or preserves approval.
- Old attempts and diagnostic evidence remain available after recovery.
- Published and ambiguous publication outcomes cannot enter upload recovery.
- No automatic retry loop or manual SQL repair is part of the supported flow.
- A crash cannot commit half a recovery transition.
- Read-only inspection remains usable without initializing write-capable stores.
- Dashboard history is bounded and sanitized; current state is not overwritten.

## Implementation reconciliation and deviations

Implementation comparison and full verification are complete. Inspection uses
an existing read-only SQLite handle and never
initializes execution/ledger stores. It checks persisted approval, identity and
container fields, verifies artifact bytes before and after provider GETs, and
rejects changed snapshots. The final fingerprint check is repeated inside the
BEGIN IMMEDIATE recovery transaction.

Apply owns the existing worker lock, reinspects from scratch and checks expected
attempt/container identifiers. The transaction preserves the old container in
the old attempt, retains diagnostics, appends sanitized fresh evidence and a
unique recovery audit, clears active fields and approval, and returns to queued.
Legacy upload_requested attempts become failed. Already-failed attempts retain
their error code; generic retry permission is revoked. A fresh approval and claim
allow beginAttempt to consume the audit once when inserting a replacement.

The worker needs one additional dispatch check for that audited replacement;
its create/upload/poll/publish ordering and safety checks are unchanged. Artifact
verification moved unchanged into publishing-artifact.mjs for shared use.
The actual browser module is app.mjs, rather than app.js named in the plan.
History reads the latest 20 attempts without schema initialization, with fixed
outcome labels, allowlisted local codes, numeric provider codes, and recovery
timestamps. Failed history loading leaves approval controls visible and reports
that history is unavailable. There is no dashboard recovery button.

### Operator commands

These commands are for a later separately authorized operation. Supply existing
configuration through the established environment setup; do not put credentials
in arguments. Use fresh inspection output, never historical attempt/container
values. DB and project-root paths must be absolute.

```sh
node scripts/publishing-recover.mjs --item "$ITEM_ID" \
  --db "$PUBLISHING_DB" --project-root "$PROJECT_ROOT"

node scripts/publishing-recover.mjs --item "$ITEM_ID" \
  --db "$PUBLISHING_DB" --project-root "$PROJECT_ROOT" \
  --apply --expected-attempt "$ATTEMPT_ID" --expected-container "$CONTAINER_ID"
```

The first command defaults to inspection. Apply repeats the GETs and may refuse
changed or inaccessible state. Exit 0 means eligible inspection or locally
requeued for approval, never publication. Exit 1 means blocked/stopped. The CLI
suppresses raw exception messages. Inspect reason codes identify state and evidence
blocks; a failed artifact/provider/configuration check returns RECOVERY_CHECK_FAILED.
Do not blindly retry an interrupted apply: inspect its current local state.

After successful recovery a human must use Approve + Schedule, then separately
authorize the existing item-scoped publishing worker. Unknown creation without
an ID, publication intent/media IDs, expired/inaccessible containers, incomplete
or contradictory evidence, and stale snapshots stay blocked. Processing-only
errors stay blocked even when their provider code resembles an upload failure.

### Verification and review

Final verification: publishing 151/151; broader Node suite 450/450;
lint/TypeScript passed; feature-doc validation passed for 18 notes; whitespace
check passed. Fresh-worktree missing dependency failures were resolved with
lockfile npm ci --ignore-scripts; package and lock files were unchanged.
Inline self-review was used as explicitly
requested; there was no independent reviewer. Fixture tests cover the recovery
transaction, audit failure rollback, duplicate/stale requests, fresh approval,
replacement publication, and history. The fixture browser showed queued state
and old upload failure together. Its fake MP4 bytes are intentionally unplayable;
this was a history-layout check. No live ledger or provider writes were used.
