import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPublishingLedger } from "./publishing-ledger.mjs";
import {
  enqueueCompletedArtifact,
  hashArtifact,
} from "./publishing-completion.mjs";

const setup = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "publishing-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = createPublishingLedger(join(directory, "publishing.sqlite"));
  t.after(() => ledger.close());
  return { directory, ledger };
};

const input = (directory, overrides = {}) => ({
  ledger: overrides.ledger,
  projectRoot: directory,
  artifactRelativePath: "out/clip.mp4",
  artifactHash: "sha256:fixture",
  accountId: "instagram-account-1",
  sourceVideoId: "video-1",
  clipPackageId: 7,
  treatmentId: "audiogram-basic",
  treatmentVersion: "1",
  title: "A clip",
  caption: "Default caption",
  ...overrides,
});

test("a completed non-empty MP4 creates one queued publishing record", async (t) => {
  const { directory, ledger } = await setup(t);
  await mkdir(join(directory, "out"));
  await writeFile(join(directory, "out/clip.mp4"), "media");

  const item = await enqueueCompletedArtifact(input(directory, { ledger }));

  assert.equal(item.state, "queued");
  assert.deepEqual(ledger.getQueue(), [item]);
});

test("repeating completion for the same artifact hash is idempotent", async (t) => {
  const { directory, ledger } = await setup(t);
  await mkdir(join(directory, "out"));
  await writeFile(join(directory, "out/clip.mp4"), "media");
  const completion = input(directory, { ledger });

  const first = await enqueueCompletedArtifact(completion);
  const second = await enqueueCompletedArtifact(completion);

  assert.equal(second.id, first.id);
  assert.equal(ledger.getQueue().length, 1);
});

test("rejects missing, empty, non-MP4, and outside-repository artifacts", async (t) => {
  const { directory, ledger } = await setup(t);
  await mkdir(join(directory, "out"));
  const cases = [
    ["out/missing.mp4", /ENOENT/],
    ["out/empty.mp4", /non-empty/],
    ["out/clip.mov", /MP4/],
    ["../outside.mp4", /inside the project repository/],
  ];
  await writeFile(join(directory, "out/empty.mp4"), "");
  await writeFile(join(directory, "out/clip.mov"), "media");

  for (const [artifactRelativePath, error] of cases) {
    await assert.rejects(
      enqueueCompletedArtifact(
        input(directory, { ledger, artifactRelativePath }),
      ),
      error,
    );
  }
  assert.equal(ledger.getQueue().length, 0);
});

test("hashArtifact returns a content hash for the completed MP4", async (t) => {
  const { directory, ledger } = await setup(t);
  await mkdir(join(directory, "out"));
  await writeFile(join(directory, "out/clip.mp4"), "media");
  assert.match(await hashArtifact(directory, "out/clip.mp4"), /^sha256:[0-9a-f]{64}$/);
  assert.equal(ledger.getQueue().length, 0);
});
