# Audiogram Helper (local MCP)

This development adapter accepts one YouTube video URL, queues the existing Audiograms CLI in a detached local worker, and reports verified MP4 drafts under `out/treatments/`. It does not publish or upload clips. The job ledger lives in the ignored `.local/audiogram-helper-jobs.sqlite` file.

## Prerequisites

- Node.js 22 or newer (the local ledger uses Node's built-in SQLite module)
- Install repository dependencies with `npm ci`
- The existing Audiograms prerequisites for fetching and rendering: `yt-dlp`, FFmpeg, and ffprobe
- OpenAI Secure MCP Tunnel available in your ChatGPT Developer Mode environment

## Start and connect

1. From the Audiograms repository root, run `npm run audiogram:mcp`.
2. Confirm the terminal reports `http://127.0.0.1:7331/mcp`. The process binds only to loopback; do not change the bind address or expose the port publicly.
3. In ChatGPT, enable Developer Mode and add a custom MCP app using the Secure MCP Tunnel workflow. Select this local service at `http://127.0.0.1:7331/mcp` as the tunnel target, then finish the connection in the developer UI.
4. In ChatGPT, submit one public YouTube video URL. The `create_audiogram` tool returns a job ID; call `get_audiogram_status` with that ID until it is terminal. Completed results contain repository-relative local artifact paths, not public download links.

The Secure MCP Tunnel is a private development bridge, not hosting. The tunnel configuration and credentials remain in the user/account environment and are not stored by this project. A service restart preserves recorded job outcomes; a worker that disappears before recording its result is reported as failed. A future cloud deployment would replace the local runner and artifact store while retaining the MCP contract; it is not configured here.

## Tools

- `create_audiogram({ url })`: validate the supported YouTube URL, create or reuse an active local job for that video, and return its opaque job ID.
- `get_audiogram_status({ jobId })`: return status and, only after verification, local artifact paths.

## Template choice

`create_audiogram` accepts optional `templateId`, `templateVersion` and `variationId` fields.
The current values are `classic`, `1` and `default`.
Omitted fields use those defaults. Invalid choices fail before job creation.

The job store records the canonical choice. The detached worker forwards that choice to the CLI.
An active request for the same video and render identity reuses the existing job.
A request for another template while that video is active returns a conflict.
This preserves one active worker per video and prevents races during asset acquisition.
The helper does not reuse completed jobs. The pipeline ledger can reuse completed renders.

The store migrates old records to Classic / Default in a transaction.
Existing job IDs, statuses and results remain intact.
Tests use temporary databases. Development verification does not migrate the user's live job database.
