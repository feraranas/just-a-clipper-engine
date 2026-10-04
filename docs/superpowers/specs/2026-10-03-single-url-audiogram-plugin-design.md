# Single URL Audiogram plugin design

Date: 2026-10-03
Status: Design for review

## Goal

Let the user submit one YouTube video URL in ChatGPT Developer Mode and receive captioned MP4 clip drafts rendered by the existing Audiograms project. During development, connect a loopback-only Streamable HTTP MCP service to ChatGPT through OpenAI Secure MCP Tunnel.

## Context and constraints

- The current Audiograms command discovers work from a private YouTube playlist. It can filter to a video ID only after listing that playlist, so it is not yet a direct single-URL workflow.
- Transcript retrieval, clip packaging, ledger handling, and Remotion rendering already exist in the project.
- Most Replayed heatmap selection is the current default. Transcript-derived selection remains an explicit existing configuration choice.
- The source is a YouTube URL in V1. Other video hosts and local file uploads are excluded.
- Generated artifacts stay local. Publishing is not part of this plugin workflow.
- Secure MCP Tunnel is a development connection only; no public listener or tunnel credential is part of the repository.
- Keep a transport-neutral runner/job interface so a later Cloud Run service and Cloud Run Job can preserve the ChatGPT-facing tool/result contract. Cloud deployment and public distribution are not part of V1.
- The working tree contains unrelated ongoing changes. Implementation must preserve them and touch only files needed for this feature.

## Approaches considered

1. **Plugin instructions that ask the model to run project commands directly.** Smallest initial package, but it couples the workflow to shell instructions, gives weak structured job results, and is brittle as the project evolves.
2. **Local Streamable HTTP MCP service with a stable Audiograms command/runner contract.** The service exposes job creation and status tools, accepts a URL, and dispatches local processing; Audiograms owns validation, selection, persistence, and rendering. ChatGPT Developer Mode reaches the loopback service through Secure MCP Tunnel. This adds a narrow adapter and job lifecycle, keeps the boundary testable, and leaves the runner/artifact-store seam for Cloud Run later. Recommended.
3. **Remote/cloud plugin service.** Easier to distribute broadly, but it cannot naturally use the user's local Audiograms checkout, media tools, credentials, or output folder. It would require separate hosting and storage decisions, so it is outside V1.

## Recommended design

Create a local MCP service in the Audiograms repository, listening only on loopback at `/mcp` with Streamable HTTP. Connect it to ChatGPT Developer Mode manually through Secure MCP Tunnel. Expose `create_audiogram` and `get_audiogram_status` so a long render is not misrepresented as a finished synchronous tool call. The service invokes a documented project command/runner interface rather than importing pipeline internals. The local runner validates the URL, resolves metadata, creates or resumes work through the existing ledger and selection flow, and renders with the existing Remotion treatment. Results include versioned status and, only when verified, project-relative local MP4 paths.

The command and runner interface act as compatibility seams. If the pipeline's internal modules or treatment implementation change, update the local adapter and preserve the MCP tool/result contract where possible. A future Cloud Run service can host the same `/mcp` contract, replace the local runner with Cloud Run Job dispatch, and replace local paths with Cloud Storage download links. Version the public contract if a breaking change becomes necessary. Cloud resources, credentials, and deployment are out of scope for V1.

The plugin should expose progress/failure information without fabricating a completed artifact. It must surface prerequisites such as missing source tools or captions using the project's diagnostics. It should not silently switch selection modes, upload assets, or publish clips.

## Flow and lifecycle

The system flow and lifecycle are recorded in [the feature flow note](../../features/single-url-audiogram-plugin.md). In brief:

```text
YouTube URL → ChatGPT Developer Mode → Secure MCP Tunnel → loopback `/mcp`
→ create job → local runner/command → existing selection and ledger
→ Remotion render → status polling → verified local MP4 paths returned
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
- Third-party publishing or sharing.
- Cloud Run/Cloud Storage deployment, production authentication, public hosting, and public directory submission.

## Open implementation details

- Choose the exact command invocation and output schema after inspecting existing core boundaries during implementation.
- Decide whether a single URL's ledger identity can be represented cleanly with the current schema or requires a small migration.
- Confirm the local plugin manifest and MCP startup path using the installed plugin tooling before packaging or installation.

## Review checklist

- [ ] Confirm V1 is YouTube URL only.
- [ ] Confirm current project selection defaults are retained.
- [ ] Confirm outputs are local MP4 files and publishing is excluded.
- [ ] Confirm the stable command contract is the plugin integration boundary.
