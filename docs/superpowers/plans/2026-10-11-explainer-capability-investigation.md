# Animated Explainer Capability Investigation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this plan task by task. Work inline. Do not dispatch subagents.

**Goal:** Establish verified Remotion capabilities and define the first scene-block contracts before implementing the explainer pipeline.

**Architecture:** Separate browser Studio tools from rendering APIs and our proposed explanatory blocks. Record observed contracts and test one representative mechanism through existing preview facilities. This phase produces evidence and contracts, not a production explainer.

**Tech Stack:** Existing Remotion project, Studio WebMCP, browser automation, Node.js, Markdown, and existing project tests.

**Spec:** `docs/features/animated-explainer.md`.

## Global Constraints

- The pipeline never selects a candidate on behalf of the user.
- Model outputs never become executable rendering code.
- Classic V1 retains its existing behavior.
- Discovery lists only implemented and supported templates.
- Do not make production depend on an open Studio tab by accident.
- Use no subagents. Preserve unrelated local files and tracked edits.
- This phascccacccczxddds no provider calls, installs no packages, and publishes no media.
- Keep the feature in DESIGN with implementation-reconciled false.

## Scope and delivery sequence

The design spans several systems. Use separate reviewed implementation plans:

1. Capability investigation and initial scene contracts: this plan.
2. Source evidence, candidate preparation, durable selection, and MCP review.
3. Script revisions, evidence checks, and script approval.
4. Narration generation, audio timing, and narration acceptance.
5. Scene planning, sanctioned renderer blocks, and draft review.
6. Remote media delivery and end-to-end production verification.

Each later plan must define actual modules, provider choices where relevant,
contracts, tests, and feature-note scope before implementation.
This plan does not authorize those later implementation stages.

## File map

| File | Action and purpose |
|---|---|
| `docs/features/animated-explainer.md` | Preserve the approved overall design and add investigation conclusions |
| `docs/investigations/remotion-explainer-capabilities.md` | Create the observed capability map and evidence |
| `docs/superpowers/plans/2026-10-11-explainer-capability-investigation.md` | Track this investigation |
| `src/templates/catalog.mjs` | Read supported templates without adding unimplemented entries |
| `plugins/audiogram-helper/server.mjs` | Read current MCP discovery and creation interfaces |
| `scripts/jev-client.mjs` | Read candidate-judgment contract for the next slice |
| `scripts/jev-transcript-ranking.mjs` | Read current transcript-ranking assumptions |

No product code changes belong to this phase.

## Review Focus

- Studio absent or unreachable: report the observed limitation instead of declaring tools absent.
- Tool schemas differ from online documentation: save the installed contract and version, then describe the difference.
- DOM inspection omits Canvas or WebGL pixels: require actual visual evidence for those elements.
- A browser-only tool cannot run in the one-run worker: classify it as development review unless an explicit worker integration exists.
- A numerical demonstration gives plausible but wrong values: require explicit data and a checked operation trace in the block contract.

### Task 1: Record the installed environment

**Files:** Read `package.json`, `src/templates/catalog.mjs`, and helper interfaces. Create the investigation note.

**Produces:** Versioned environment evidence and a list of capabilities still unverified.

- [x] Read applicable repository guidance and the Remotion Studio skill before launching Studio.
- [x] Record the current checkout, branch, HEAD, installed package version, and any existing Studio listener.
- [x] Inspect existing browser tabs through the browser tool inventory. Reuse a matching Studio tab where available.
- [x] If Studio is absent, launch the existing project with its installed dependencies. Record the actual local URL. Do not install or upgrade dependencies.
- [x] If startup fails, save the exact first blocker. Continue documentation research, but label live checks blocked.
- [x] Create the investigation note with environment, official sources, observed tools, worker suitability, and open limitations.

Acceptance: environment observations identify a concrete version and access path, or a concrete blocker.

### Task 2: Discover and inspect Studio tools

**Consumes:** The verified Studio browser surface from Task 1.
**Produces:** Tool names, input schemas, output schemas where exposed, and observed results.

- [x] Use the browser surface's documented WebMCP discovery interface. Save its actual tool inventory. Do not assume direct MCP inventory includes browser tools.
- [x] Compare each name with the official WebMCP documentation through Context7 and official pages.
- [x] Exercise read-only composition, sequence, playback-state, current-error, canvas-HTML, and outline inspection where exposed.
- [x] Record prerequisites and errors without hiding unavailable results.
- [x] Inspect a known composition at its current frame. With a safe preview open, seek to a representative frame and check playback controls.
- [x] Do not call install, shutdown, background-removal, or transcription tools in this inventory phase. Record their schemas and requirements only.
- [x] Check whether returned HTML covers the visual surface. Mark omitted Canvas or WebGL content as requiring frame inspection.

Acceptance: each listed capability has an evidence label. No documented capability is described as locally verified without an observed result.

### Task 3: Map capabilities to the scene planner

**Consumes:** Task 2 inventory and the approved visual reference.
**Produces:** Initial block contracts and reuse decisions in the investigation note.

- [x] Map preview, timing, layout checks, captions, audio alignment, and rendering to existing APIs or tools.
- [x] Separate browser review operations from worker operations. Specify which need Studio and which can run without it.
- [x] Define a representative `binary-search` block contract as proposed work. Require sorted finite values, a target, timing cues, and an operation trace.
- [x] Define allowed actions: show list, highlight midpoint, narrow range, update count, and show result. Reject arbitrary code and unknown actions.
- [x] Specify a trace for values `[2, 4, 6, 8, 10, 12, 14]` and target `12`: inspect index 3, retain indexes 4 through 6, inspect index 5, finish with two comparisons.
- [x] Define the counter as a view of those same events. It must not accept a separately invented comparison count.
- [x] Define block identity, version, input schema, timing units, text-fit limits, and unsupported-input errors.
- [x] Specify the proposed `list_scene_blocks` response with block contracts and catalog revision. Keep planned blocks unavailable to production discovery.
- [x] Record whether any existing project component already meets the contract. Do not describe a proposed block as implemented.

Acceptance: the planner contract explains what data produces the visual result and how incorrect or unsupported plans fail.

### Task 4: Reconcile evidence and prepare the next implementation plan

**Consumes:** Investigation conclusions. **Produces:** A reviewed investigation and a bounded next-slice brief.

- [x] Compare the investigation with the design. Record intentional changes without changing implementation completion metadata.
- [x] Define the next slice as source evidence and candidate review. Preserve current `create_audiogram` behavior.
- [x] Identify how existing transcript extraction can run without rendering or publishing. Record exact module interfaces before planning new code.
- [x] Evaluate the current Jev contract. It judges candidates rather than generating their prose. Assign candidate drafting and judgment separately in the next plan.
- [x] Define source IDs, passage IDs, candidate revisions, explicit selection, duplicate-request behavior, and shared-storage boundaries in that next-slice brief.
- [x] Run `npm run verify:feature-docs` and check the documentation diff for unrelated changes.
- [x] Present verified findings and limitations to the user. Request review of the scene contract and next-slice plan before product implementation.

Acceptance: every proposed capability has evidence or an explicit implementation requirement. Provider or browser limitations remain visible.

## Execution handoff

Recommended method: inline execution with focused checks and diff review.
Repository policy defaults to no subagents. Review this plan before execution.
The full feature remains unimplemented when this investigation ends.

## Execution record

Executed inline on 2026-10-11. Evidence and the next-slice brief are in
`docs/investigations/remotion-explainer-capabilities.md`. The feature remains
unimplemented. Live inventory and preview checks passed. No asset jobs,
provider calls, package installation, or new composition ran.

Ruling: used focused inline review, as required by repository policy.
Ruling: retained contracts as proposals. A working block needs a separate
implementation plan and render verification.
