import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storeArtifact,
  artifactLocation,
  hashFile,
} from "./artifact-store.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";

test("one configuration resolves durable storage and detects conflicting legacy aliases", () => {
  const c = resolveStorageConfig({ AUDIOGRAM_DATA_ROOT: "/tmp/shared" });
  assert.equal(c.processingDb, "/tmp/shared/audiograms.sqlite");
  assert.equal(c.artifactRoot, "/tmp/shared");
  assert.equal(
    resolveStorageConfig({ PUBLISHING_DB: "/tmp/old.db" }).publishingDb,
    "/tmp/old.db",
  );
  assert.throws(() =>
    resolveStorageConfig({ AUDIOGRAM_DATA_ROOT: "relative" }),
  );
  assert.throws(
    () =>
      resolveStorageConfig({
        PUBLISHING_DB: "/tmp/a",
        INSTAGRAM_PUBLISHING_DB_PATH: "/tmp/b",
      }),
    /Conflicting/,
  );
});

test("durable video survives producer removal and has an immutable manifest", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "durable-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = join(base, "checkout-a"),
    b = join(base, "checkout-b"),
    store = join(base, "data");
  await mkdir(a);
  await mkdir(b);
  const video = join(a, "video.mp4");
  await writeFile(video, "synthetic-video");
  const manifest = join(a, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({ artifactHash: (await hashFile(video)).slice(7) }),
  );
  const ref = await storeArtifact({
    projectRoot: a,
    videoPath: video,
    manifestPath: manifest,
    artifactRoot: store,
  });
  assert.equal(
    await storeArtifact({
      projectRoot: a,
      videoPath: video,
      manifestPath: manifest,
      artifactRoot: store,
    }),
    ref,
  );
  await rm(a, { recursive: true });
  const located = await artifactLocation(b, ref, { artifactRoot: store });
  assert.equal(await readFile(located.path, "utf8"), "synthetic-video");
  await writeFile(located.path, "corrupt");
  await mkdir(a);
  await writeFile(video, "synthetic-video");
  await writeFile(
    manifest,
    JSON.stringify({ artifactHash: (await hashFile(video)).slice(7) }),
  );
  await assert.rejects(
    storeArtifact({
      projectRoot: a,
      videoPath: video,
      manifestPath: manifest,
      artifactRoot: store,
    }),
    /different bytes|missing or invalid/,
  );
});

test("promotion rejects bad hashes, checkout storage and path escapes", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "durable-invalid-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const video = join(project, "video.mp4");
  await writeFile(video, "video");
  await assert.rejects(
    storeArtifact({
      projectRoot: project,
      videoPath: video,
      artifactRoot: join(project, "store"),
    }),
    /outside/,
  );
  await assert.rejects(
    storeArtifact({
      projectRoot: project,
      videoPath: video,
      artifactRoot: join(base, "store"),
      expectedHash: "sha256:bad",
    }),
    /hash/,
  );
  for (const path of [
    "../video.mp4",
    "out/../video.mp4",
    "/tmp/video.mp4",
    "artifacts/invalid/video.mp4",
  ])
    await assert.rejects(artifactLocation(project, path), {
      code: "ARTIFACT_UNAVAILABLE",
    });
  await mkdir(join(project, "out"));
  await symlink(video, join(project, "out/link.mp4"));
  await assert.rejects(artifactLocation(project, "out/link.mp4"), {
    code: "ARTIFACT_UNAVAILABLE",
  });
});
