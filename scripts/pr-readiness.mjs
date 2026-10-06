import { readFileSync } from 'node:fs';
import { checkFeatureReadiness } from './feature-doc-readiness.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const pullNumber = process.env.PR_NUMBER;
const token = process.env.GH_TOKEN;

if (!repository || !pullNumber || !token) {
  throw new Error("GITHUB_REPOSITORY, PR_NUMBER, and GH_TOKEN are required");
}

const response = await fetch(
  `https://api.github.com/repos/${repository}/pulls/${pullNumber}`,
  {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  },
);
if (!response.ok) throw new Error(`GitHub PR lookup failed: ${response.status}`);
const pull = await response.json();

const files = [];
for (let page = 1; ; page++) {
  const filesResponse = await fetch(
    `https://api.github.com/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
    { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } },
  );
  if (!filesResponse.ok) throw new Error(`GitHub changed-file lookup failed: ${filesResponse.status}`);
  const batch = await filesResponse.json();
  files.push(...batch);
  if (batch.length < 100) break;
  if (page >= 30) throw new Error("PR exceeds GitHub changed-file listing limit; cannot verify readiness");
}
if (files.length !== pull.changed_files) throw new Error("PR file list changed or is incomplete; rerun readiness");
const problems = checkFeatureReadiness({ body: pull.body, files, readDocument: path => readFileSync(path, 'utf8') });
if (pull.draft) problems.push('PR is still a draft');
if (pull.mergeable === false || pull.mergeable_state === "dirty") {
  problems.push(`mergeability is ${pull.mergeable_state ?? "conflicting"}`);
}
if (pull.state !== "open") problems.push(`PR state is ${pull.state}`);

if (problems.length > 0) {
  console.error(`PR #${pullNumber} is not ready: ${problems.join("; ")}`);
  process.exit(1);
}

console.log(`PR #${pullNumber} passed readiness checks (open, non-draft, no known conflicts, feature documents reconciled where required).`);
