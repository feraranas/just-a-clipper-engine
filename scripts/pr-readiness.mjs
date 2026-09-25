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

const problems = [];
if (pull.mergeable === false || pull.mergeable_state === "dirty") {
  problems.push(`mergeability is ${pull.mergeable_state ?? "conflicting"}`);
}
if (pull.state !== "open") problems.push(`PR state is ${pull.state}`);

if (problems.length > 0) {
  console.error(`PR #${pullNumber} is not ready: ${problems.join("; ")}`);
  process.exit(1);
}

console.log(`PR #${pullNumber} is mergeable and open.`);
