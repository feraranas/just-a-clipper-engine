# ChatGPT live-events acceptance

Status: NOT ACCEPTED. Local tests do not prove ChatGPT presentation.
Prepared on 2026-11-04. Remote plugin source and version: not inspected or updated.
Target chat, job IDs, subscription IDs, and live event IDs: not recorded.

## Evidence levels

1. Wire tests prove tool guidance and protocol responses.
2. Instruction checks prove required text exists, not that a model follows it.
3. Synthetic signed-receiver tests prove data delivery, not a ChatGPT response.
4. Only observed ChatGPT messages prove automatic progress and final presentation.

Do not replace level 4 with manual polling or callback HTTP acknowledgment.
The source is `plugins/audiogram-helper/CHATGPT-INSTRUCTIONS.md`.
Saving that file does not deploy remote instructions.

## Operator approvals and preparation

Obtain separate approval before each remote update or visible service startup.
Inspect the owned plugin's editable source before choosing its update mechanism.
Preserve its identity, scope, permissions, and existing instructions.
Record the actual remote version and a redacted source reference after an update.
Never paste keys, callback URLs with query strings, signing secrets, or raw event bodies into this record.

Use a supported ChatGPT Work chat on web, or Work with Cloud in the desktop app.
The operator starts MCP visibly and connects its private tunnel.
Use an isolated test database and an approved synthetic fixture driver.
Do not add public test tools or invoke real video processing to simulate a fixture.
Refresh discovery and check that both event names appear alongside the four tools.

## Live test request

Ask ChatGPT: "Monitor this approved test job. Report meaningful stage updates and its final outcome without another prompt."
Supply the synthetic job ID from the approved test driver.
Confirm subscriptions to both names with that job's filter.
Confirm signed callback verification before sending stage facts.
Observe a progress reply before completion, then a final reply without another user prompt.

## Acceptance matrix

| Case | Local evidence | Live ChatGPT evidence |
| --- | --- | --- |
| Create/retry guidance and four tools | Pending current run | Not run |
| Both subscriptions and signed callback | Existing backend tests | Not run |
| Stage start/completion/failure/recovery/skipping | Pending current run | Not run |
| Two clip instances and partial artifacts | Pending current run | Not run |
| Complete/failed/no-clips | Pending current run | Not run |
| Fast completion before subscription | Pending current run | Not run |
| Finish before delayed progress | Pending current run | Not run |
| Duplicate delivery and catch-up history | Pending current run | Not run |
| Expiry/cancellation/restart | Existing backend tests | Not run |
| Concise replies and measured batching | Not provable locally | Not run |

For every live case, record the redacted chat reference, host surface, server commit,
remote plugin version, job/subscription/event IDs, occurrence/receipt/display times,
displayed text, batching, and whether a user prompted again. Record unobserved values as unknown.
Check that skipped Jev is not failure and a recovered selection is not a new attempt.
Check that delayed progress cannot regress a final result or flood the chat.
Stop monitoring and confirm unsubscribe. Confirm processing remains unchanged.
Repeat expiry/renewal and service restart with operator approval.

## Completion gate

Keep PR 5 draft and both feature notes IN_PROGRESS until live criteria pass.
If only receipt is observed, record: "Callback received. ChatGPT presentation is not verified."
After actual acceptance, reconcile both notes and run all repository gates.
A real video smoke requires explicit approval. Instagram publishing is not a verification step.

Protocol reference: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), checked 2026-11-04.
