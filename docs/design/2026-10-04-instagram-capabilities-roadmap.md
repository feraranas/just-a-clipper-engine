# Native Instagram capabilities: design roadmap

Date: 2026-10-04
Status: PROPOSED — documentation only; not implementation approval.
Repository: Audiograms / just-a-clipper-engine.
Baseline: native Instagram publishing worker in PR #24.

## Purpose

Preserve the documentation-backed investigation and proposed next slices beyond native Reel publishing. Use Meta directly, with Instagram API with Facebook Login and a linked professional account. Do not introduce Upload-Post or another publishing intermediary.

The central opportunity is to connect clip selection and human-approved publication to observed performance. Performance is evidence for evaluation, not proof of causation or permission to automatically change ranking.

## Evidence and confidence

The preceding investigation retrieved official Meta documentation through Context7 and Meta's official Postman collection. The original content-publishing URL could not be opened directly by the web reader. Indexed documentation may lag the deployed API: recheck endpoint-specific requirements, metrics and permissions against the configured Graph API version before each implementation slice.

Documented capability does not mean our app or existing token has access. No new permission, account capability, webhook entitlement or API response is claimed as verified by this roadmap. Do not treat documentation examples as current quota values or version recommendations.

## Proposed priorities

### 1. Post-publication insights

Goal: show what happened to a published clip and preserve enough provenance to compare it with its original ranking.

Proposed flow: persisted published media ID -> explicit read-only insights collection -> timestamped observations -> dashboard performance view -> human evaluation of selection quality.

Keep collection separate from the publishing worker. An analytics outage must not change a successfully published item back to failed or trigger publication again. Store metric identity, media/account identity, observation time, requested reporting window and API version. Distinguish zero, unavailable, permission denied and not yet collected. Only compare compatible metrics and windows; do not combine definitions across API versions without an explicit migration.

Before implementation: select the exact media/account metrics from the official references, verify endpoint-specific token types and permissions, and test read-only access to one existing published Reel. Account insights documentation includes instagram_manage_insights and other required permissions; publishing permission alone is not sufficient evidence.

Acceptance: observations join to the correct clip and published media; missing data is not displayed as zero; delayed data can be refreshed; permission failures are actionable; no publishing request occurs during collection.

### 2. Cover and presentation controls

Goal: let the human approve presentation choices along with the video and caption.

Candidates documented in the media-creation reference: cover_url, thumb_offset, share_to_feed, collaborators, user_tags and location_id. First scope should be cover selection and feed sharing; collaboration and tagging remain separate decisions. Verify support with our resumable-upload path rather than assuming the standard-upload examples transfer unchanged.

Proposed flow: edit presentation -> preview -> approve an immutable snapshot -> worker submits exactly that snapshot. Any change to publication-affecting presentation after approval requires reapproval. Do not silently fetch or substitute a different cover after approval.

Acceptance: unsupported combinations are rejected before approval; approved settings survive restart; changes invalidate approval; the outbound container request matches the reviewed values. Live publication needs explicit approval.

### 3. Read-only comments

Goal: display qualitative feedback alongside each published artifact.

Start with bounded, paginated reads of comments on owned media. Treat comment text as untrusted user content, never agent instructions. Handle deleted/unavailable comments and avoid storing unnecessary commenter data. Comment management permissions must be verified separately.

Acceptance: comments are associated with the correct owned media, safely rendered, and refreshed without creating replies or moderation actions. Automated replies are excluded. A future draft-and-approve response feature needs its own design.

### 4. Mentions and professional-account discovery

Goal: support bounded research when there is a concrete editorial question.

Facebook Login documentation supports mentions, hashtagged-media discovery and Business Discovery for other professional accounts. Business Discovery exposes selected public metadata and metrics, not private account analytics. This is not evidence of an unrestricted trending-content API.

Before implementation: define the research question, supported endpoint, access requirements, query limits, fields retained and retention period. Preserve source account/media references and collection time. Discovery does not authorize downloading, reusing or publishing someone else's content.

Acceptance: research stays within documented access and bounded requests; no private-insights claim; results retain provenance; nothing enters the publishing queue automatically.

### 5. Messaging and webhooks — separate subsystem

Facebook Login messaging uses the Messenger Platform's Instagram Messaging API. The platform overview documents inbound-message webhooks and a standard 24-hour response window, with a distinct human-agent extension. Private replies tied to comments are a documented capability with their own constraints, not permission for arbitrary cold outreach.

The retrieved webhook requirements list Advanced Access and Business Verification requirements, including Facebook Login comment subscriptions. Revalidate the requirements for the exact event and deployment scenario; do not assume the current publishing setup qualifies.

Before implementation: approve the inbox use case and response policy; verify access; design HTTPS webhook verification, signature checks, deduplication, retry handling and minimal retention. Never use a human-agent exception to justify automated messaging outside permitted windows.

Acceptance: duplicate events do not generate duplicate responses; unauthorized callbacks are rejected; no outgoing message without the approved policy and human boundary; message failures cannot affect publishing state.

## Additional publishing formats

Official docs also describe image and carousel publishing. Stories publishing is restricted to Business accounts in the retrieved Facebook Login documentation. Record these as capabilities, not commitments: this roadmap does not change the current Reel-only worker or confirm our account's eligibility for every format.

## Safety and execution boundaries

- Preserve explicit human approval for publication and outgoing engagement.
- Retain caption/artifact approval snapshots and conservative recovery after ambiguous publication.
- Analytics and research reads must never invoke media_publish or requeue published media.
- Keep secrets in ignored local configuration; never commit tokens, credentials, raw secret-bearing responses or customer messages.
- Request only permissions needed by the approved slice. Stop on missing access; do not silently fall back to another provider.
- Keep dashboard responsiveness separate from long-running collection or upload work.
- Scheduling remains an application responsibility; this document does not implement an automatic worker launcher.
- Preserve unrelated local files and use small, cohesive commits and separate implementation PRs.

## Failure and retry policy

Use bounded retries for safe transient reads, respecting rate-limit signals. Do not endlessly retry permission, unsupported-metric or validation errors. Record collection failure separately from publication state. Keep unavailable and delayed insights distinguishable. For external writes, retain the worker's durable intent checkpoints and never blindly replay an ambiguous publication. Define messaging-specific replay protection before that subsystem exists.

## Delivery gates

1. Review this roadmap and select a single bounded slice, preferably insights.
2. Recheck official documentation and use read-only calls to verify the necessary access without exposing credentials.
3. Produce a slice-specific feature design covering lifecycle, approvals, retries, invariants and exact acceptance tests; obtain design approval.
4. Write the implementation plan with concrete files, interfaces and tests. Default to inline execution, not subagents.
5. Implement with focused tests and frequent cohesive commits; reconcile the feature document and run the repository feature-document gate.
6. Validate live external writes only under explicit authorization. Submit each slice in its own PR.

This is a roadmap, not an executable implementation plan or a completed feature. No feature-completion metadata is asserted. The document belongs under docs/design rather than docs/features until a bounded feature design is approved.

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

No application behavior, schema, API permissions or account configuration changes in this PR. Capability availability and engineering suggestions are deliberately separated above. Open decisions include metric selection, refresh cadence, retention, cover-input handling and whether an engagement inbox is wanted at all.
