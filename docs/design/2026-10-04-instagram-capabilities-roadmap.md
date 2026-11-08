# Native Instagram capabilities: design roadmap

Date: 2026-10-04

Status: PROPOSED. This document does not authorize implementation.

Repository: Audiograms / just-a-clipper-engine.

Baseline: the native Instagram publishing worker in PR #24.

## Purpose

This document records the investigation of Meta documentation and proposes features beyond native Reel publishing.
Use Meta directly through Instagram API with Facebook Login and a linked professional account.
Do not add Upload-Post or another publishing intermediary.

The proposed features connect clip selection and human-approved publication to measured performance.
Performance provides evidence for evaluation, not proof of causation.
Performance data does not authorize automatic changes to ranking.

## Evidence and confidence

The investigation retrieved official Meta documentation through Context7 and Meta's official Postman collection.
The web reader could not open the original content-publishing URL directly.
Indexed documentation may lag the deployed API.

Before each implementation phase, check these details against the configured Graph API version:

- Requirements for each endpoint.
- Available metrics.
- Required permissions.

A documented capability does not prove that our app or token has access.
This roadmap does not claim that checks established any new permission, account capability, webhook access, or API response.
Do not treat documentation examples as current quota values or version recommendations.

## Terms

- An approval snapshot records the values that a human approved.
- A checkpoint records execution progress for a later recovery attempt.
- An ambiguous publication means that the system does not know whether Meta published the media.
- A webhook delivers an event notification to a server.
- Provenance identifies the source and collection time of data.

## Proposed priorities

### 1. Post-publication insights

Goal: show the performance of each published clip.
Preserve enough provenance to compare its performance with its original ranking.

Proposed sequence:

1. Read the stored ID of the published media.
2. Explicitly collect insights through read-only requests.
3. Store each observation with its timestamp.
4. Show performance in the dashboard.
5. Let a human evaluate the quality of clip selection.

Keep insights collection separate from the publishing worker.
An analytics outage must not change a published item to failed.
An analytics outage must not cause another publication attempt.

Store these details for each observation:

- Metric identity.
- Media and account identity.
- Observation time.
- Requested reporting window.
- API version.

Distinguish zero, unavailable data, denied permission, and data not yet collected.
Compare only compatible metrics and reporting windows.
Do not combine metric definitions across API versions without an explicit migration.

Before implementation:

1. Select the exact media and account metrics from the official references.
2. Check the token types that each endpoint requires.
3. Check the permissions that each endpoint requires.
4. Test read-only access to one existing published Reel.

Account insights documentation includes `instagram_manage_insights` and other required permissions.
Publishing permission alone does not prove access to insights.

Acceptance criteria:

- Each observation links to the correct clip and published media.
- The dashboard does not show missing data as zero.
- The system can refresh delayed data.
- Permission errors tell the operator what action is necessary.
- Insights collection sends no publishing requests.

### 2. Cover and presentation controls

Goal: let a human approve presentation choices with the video and caption.

The media-creation reference documents these candidate parameters:

- `cover_url`
- `thumb_offset`
- `share_to_feed`
- `collaborators`
- `user_tags`
- `location_id`

The first phase should include cover selection and feed sharing.
Collaboration and tagging remain separate decisions.
Check support in our resumable-upload implementation.
Do not assume that the standard-upload examples apply unchanged.

Proposed sequence:

1. The human edits the presentation.
2. The human reviews the preview.
3. The human approves an immutable snapshot.
4. The worker submits exactly those values.

Require new approval after any change to presentation values that affect publication.
Do not silently retrieve or substitute a different cover after approval.

Acceptance criteria:

- The system rejects unsupported combinations before approval.
- The system preserves approved settings after a restart.
- Changes to publication values invalidate approval.
- The container request matches the reviewed values.
- Live publication requires explicit approval.

### 3. Read-only comments

Goal: show qualitative feedback beside each published artifact.

Start with bounded, paginated reads of comments on owned media.
Treat comment text as untrusted user content, not agent instructions.
Handle deleted and unavailable comments.
Avoid unnecessary storage of commenter data.
Check comment-management permissions separately.

Acceptance criteria:

- Each comment links to the correct owned media.
- The dashboard renders comment text safely.
- Comment refresh sends no replies and performs no moderation actions.

This phase excludes automated replies.
A future feature for drafted, human-approved responses requires a separate design.

### 4. Mentions and professional-account discovery

Goal: support bounded research for a specific editorial question.

Facebook Login documentation supports mentions, hashtagged-media discovery, and Business Discovery for other professional accounts.
Business Discovery exposes selected public metadata and metrics, not private account analytics.
These capabilities do not establish that an unrestricted API for trending content exists.

Before implementation, define:

- The research question.
- The supported endpoint.
- Access requirements.
- Query limits.
- Fields to retain.
- The retention period.

Preserve source references for each account and media item.
Preserve the collection time.
Discovery does not authorize downloads, reuse, or publication of another person's content.

Acceptance criteria:

- Research uses documented access and bounded requests.
- The system makes no claim of access to private insights.
- Results retain their provenance.
- The system adds nothing to the publishing queue automatically.

### 5. Messaging and webhooks: separate subsystem

Facebook Login messaging uses the Messenger Platform's Instagram Messaging API.
The platform overview documents webhooks for incoming messages and a standard 24-hour response window.
It also documents a separate extension for human agents.
Private replies to comments have their own constraints.
They do not authorize arbitrary unsolicited messages.

The retrieved webhook documentation lists requirements for Advanced Access and Business Verification.
These requirements include Facebook Login comment subscriptions.
Check the requirements again for the exact event and deployment scenario.
Do not assume that the current publishing configuration meets these requirements.

Before implementation:

1. Get approval for the inbox use case.
2. Get approval for the response policy.
3. Check access.
4. Design HTTPS webhook verification.
5. Design signature checks.
6. Design protection against duplicate events.
7. Define retry behavior.
8. Define minimal retention.

Never use a human-agent exception to justify automated messages outside permitted response windows.

Acceptance criteria:

- Duplicate events do not cause duplicate responses.
- The system rejects unauthorized callbacks.
- Outgoing messages comply with the approved policy and human-approval requirements.
- Message failures do not affect publishing state.

## Additional publishing formats

Official documentation also describes image and carousel publishing.
The retrieved Facebook Login documentation restricts Stories publishing to Business accounts.
The documentation describes capabilities, not implementation commitments.
This roadmap does not change the Reel-only worker.
It does not establish our account's eligibility for every format.

## Safety and execution boundaries

- Require explicit human approval for publication and outgoing engagement.
- Retain approval snapshots for captions and artifacts.
- Preserve conservative recovery after ambiguous publication.
- Never call `media_publish` during analytics or research reads.
- Never return published media to the queue during analytics or research reads.
- Keep secrets in ignored local configuration files.
- Never commit tokens, credentials, responses that contain secrets, or customer messages.
- Request only the permissions necessary for the approved phase.
- Stop if the required access is missing.
- Do not silently substitute another provider.
- Keep the dashboard responsive during long collection or upload tasks.
- Preserve unrelated local files.
- Make small commits with related changes.
- Use separate implementation PRs.

The application remains responsible for scheduling.
This document does not implement an automatic worker launcher.

## Failure and retry policy

Use bounded retries for safe reads after transient failures.
Respect rate-limit signals.
Do not retry permission, unsupported-metric, or validation errors indefinitely.
Record collection failures separately from publication state.
Distinguish unavailable insights from delayed insights.

Retain durable intent checkpoints for external writes.
Never blindly repeat an ambiguous publication.
Define protection against repeated messaging actions before implementation of that subsystem.

## Delivery gates

1. Review this roadmap.
2. Select one bounded phase, preferably insights.
3. Check the official documentation again.
4. Check the required access through read-only calls without exposing credentials.
5. Write a feature design for the selected phase.
6. Include its lifecycle, approvals, retries, invariants, and exact acceptance tests.
7. Get approval for that design.
8. Write an implementation plan with exact files, interfaces, and tests.
9. Use inline execution by default, not subagents.
10. Implement the feature with focused tests.
11. Make frequent commits with related changes.
12. Update the feature document to match the implementation.
13. Run the repository check for feature documents.
14. Test live external writes only with explicit authorization.
15. Submit each phase in a separate PR.

This roadmap is not an executable implementation plan or a completed feature.
It asserts no metadata that marks a feature complete.
Keep this document under `docs/design`, not `docs/features`, until a human approves a bounded feature design.

## Official source index

- [Original content-publishing documentation](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Facebook Login capabilities and limitations](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login)
- [Meta's official Facebook Login Postman collection](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login)
- [Instagram Platform overview, including messaging routing](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Account insights reference](https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights)
- [Media insights reference](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights)
- [Media/container creation and presentation parameters](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
- [Business Discovery](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery)
- [Private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies)
- [Webhook requirements](https://developers.facebook.com/documentation/instagram-platform/webhooks)

## Implementation reconciliation

This PR changes no application behavior, schema, API permissions, or account configuration.
The document separates documented capabilities from proposed engineering work.

These decisions remain open:

- Which metrics to collect.
- How often to refresh data.
- How long to retain data.
- How to handle cover inputs.
- Whether an engagement inbox is necessary.
