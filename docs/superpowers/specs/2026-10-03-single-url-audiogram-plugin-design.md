# Single URL Audiogram plugin design

Date: 2026-10-03
Status: Design for review

## Goal

Let the user submit one YouTube video URL in Codex and receive completed captioned MP4 clips rendered by the existing Audiograms project.

## Context and constraints

- The current Audiograms command discovers work from a private YouTube playlist. It can filter to a video ID only after listing that playlist, so it is not yet a direct single-URL workflow.
- Transcript retrieval, clip packaging, ledger handling, and Remotion rendering already exist in the project.
- Most Replayed heatmap selection is the current default. Transcript-derived selection remains an explicit existing configuration choice.
- The source is a YouTube URL in V1. Other video hosts and local file uploads are excluded.
- Generated artifacts stay local. Publishing is not part of this plugin workflow.
- The working tree contains unrelated ongoing changes. Implementation must preserve them and touch only files needed for this feature.

## Approaches considered

1. **Plugin instructions that ask the model to run project commands directly.** Smallest initial package, but it couples the workflow to shell instructions, gives weak structured job results, and is brittle as the project evolves.
2. **Local plugin with a stable Audiograms command contract.** The plugin exposes a focused action that accepts a URL and calls a project command; the project owns validation, selection, persistence, and rendering. This adds a narrow adapter but keeps the boundary testable and allows internal pipeline changes behind the command contract. Recommended.
3. **Remote/cloud plugin service.** Easier to distribute broadly, but it cannot naturally use the user's local Audiograms checkout, media tools, credentials, or output folder. It would require separate hosting and storage decisions, so it is outside V1.

## Recommended design

Create a local plugin in the Audiograms repository. Its local MCP action accepts a YouTube URL and optional selection preferences only where the existing project supports them. It invokes a documented project command, rather than importing the pipeline's internal modules. The command validates the URL, resolves source metadata, creates or resumes work using the existing ledger and selection flow, renders with the existing Remotion treatment, then emits a small structured result containing status, title, clip count, and project-relative MP4 paths.

The project command acts as a compatibility seam. If the pipeline's internal modules or treatment implementation change, update the command adapter and preserve the plugin tool's input/result contract where possible. Version that contract if a breaking change becomes necessary.

The plugin should expose progress/failure information without fabricating a completed artifact. It must surface prerequisites such as missing source tools or captions using the project's diagnostics. It should not silently switch selection modes, upload assets, or publish clips.

## Flow and lifecycle

The system flow and lifecycle are recorded in [the feature flow note](../../features/single-url-audiogram-plugin.md). In brief:

```text
YouTube URL → plugin action → stable project command → validate/source acquisition
→ existing selection and ledger → Remotion render → local MP4 paths returned
```

The command returns a terminal failure status for invalid URLs, unavailable source data, empty selection, or render failure. A success result is valid only when it identifies existing non-empty MP4 files under the project output area.

## Approval and side effects

The user explicitly submits a URL to start local acquisition and rendering. The only intended side effects are local pipeline/ledger state and local rendered artifacts. The plugin does not publish externally. A later publishing feature must define its own explicit approval boundary.

## Compatibility and evolution

The plugin depends on the Audiograms command contract, not specific Remotion composition names or internal JavaScript modules. Keep the contract small and document its version, accepted URL forms, terminal statuses, and result fields. The plugin's user-facing intent can remain stable while project internals change; update the adapter and tests when Audiograms changes.

## Out of scope

- Non-YouTube sources.
- Uploaded local video and transcript files.
- Local speech-to-text when captions are unavailable.
- Custom visual treatments, caption styling controls, or multi-URL batch jobs.
- Third-party publishing, sharing, or cloud hosting.

## Open implementation details

- Choose the exact command invocation and output schema after inspecting existing core boundaries during implementation.
- Decide whether a single URL's ledger identity can be represented cleanly with the current schema or requires a small migration.
- Confirm the local plugin manifest and MCP startup path using the installed plugin tooling before packaging or installation.

## Review checklist

- [ ] Confirm V1 is YouTube URL only.
- [ ] Confirm current project selection defaults are retained.
- [ ] Confirm outputs are local MP4 files and publishing is excluded.
- [ ] Confirm the stable command contract is the plugin integration boundary.
