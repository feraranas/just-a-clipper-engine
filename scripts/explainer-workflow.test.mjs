import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCandidateReviewStore } from "./candidate-review.mjs";
import { createExplainerWorkflow } from "./explainer/workflow.mjs";
import { sha256Canonical } from "./canonical-json.mjs";
const research = {
  summary: "Support the explanation",
  sources: [
    {
      id: "git",
      url: "https://git-scm.com/docs/git-push",
      title: "Git",
      passage: "A force push can replace remote commits.",
    },
  ],
};
const script = {
  title: "Check actions",
  segments: [
    { id: "s1", text: "Check actions.", kind: "factual", sourceIds: ["git"] },
  ],
};
const plan = {
  scenes: [
    {
      segmentId: "s1",
      kind: "process",
      version: 1,
      title: "Check first",
      items: ["Assess", "Decide"],
    },
  ],
};
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "explainer-test-"));
  const store = createCandidateReviewStore(join(root, "reviews.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const review = {
    candidates: [{ candidateId: "candidate-1", title: "Test", blocked: false }],
  };
  store.save({
    reviewId: "review-1",
    state: "selected",
    selection: "candidate-1",
    review,
    reviewHash: sha256Canonical(review),
  });
  const w = createExplainerWorkflow({ store, root });
  const rev = () => w.get("review-1").revision;
  const action = async (method, ...args) =>
    w[method]("review-1", rev(), ...args);
  return { w, store, root, rev, action };
}
async function ready(t) {
  const c = await setup(t);
  await c.action("research", research);
  await c.action("script", script);
  await c.action("approveScript", c.w.get("review-1").script.hash);
  const path = join(c.root, "audio.mp3");
  const bytes = Buffer.from("synthetic audio");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await c.action("narration", async () => ({
    path,
    sha256,
    duration: 1,
    words: [
      { text: "Check", start: 0, end: 0.4 },
      { text: "actions.", start: 0.4, end: 1 },
    ],
    mouthCues: [{ start: 0, end: 1, value: "B" }],
  }));
  await c.action("acceptNarration", sha256);
  return c;
}
test("script review rejects missing citations and stale approval without changing state", async (t) => {
  const c = await setup(t);
  await c.action("research", research);
  await assert.rejects(
    c.action("script", {
      ...script,
      segments: [{ ...script.segments[0], sourceIds: [] }],
    }),
  );
  await c.action("script", script);
  const revision = c.rev();
  await assert.rejects(c.action("approveScript", "old"));
  let called = false;
  await assert.rejects(
    c.action("narration", async () => {
      called = true;
    }),
  );
  assert.equal(called, false);
  assert.equal(c.rev(), revision);
  assert.equal(c.w.get("review-1").pending, undefined);
});
test("accepted stages render and scene edits retain audio while script edits invalidate it", async (t) => {
  const c = await ready(t);
  const audio = c.w.get("review-1").audio;
  await c.action("scenes", plan);
  const result = await c.action("render", async ({ scenes }) => {
    assert.equal(scenes[0].text, "Check actions.");
    return { path: "/test/video.mp4", sha256: "test" };
  });
  assert.equal(result.state, "rendered");
  await c.action("scenes", {
    scenes: [{ ...plan.scenes[0], title: "Updated diagram" }],
  });
  assert.deepEqual(c.w.get("review-1").audio, audio);
  await c.action("script", script);
  assert.equal(c.w.get("review-1").audio, undefined);
  assert.equal(c.w.get("review-1").scriptApproval, undefined);
  assert.ok(c.w.get("review-1").history.length);
});
test("concurrent drafting claims permit one provider invocation only", async (t) => {
  const c = await setup(t);
  await c.action("research", research);
  const revision = c.rev();
  let calls = 0,
    finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const gen = async () => {
    calls++;
    await pending;
    return script;
  };
  const a = c.w.draft("review-1", revision, gen);
  await new Promise((resolve) => setImmediate(resolve));
  const b = c.w.draft("review-1", revision, gen);
  finish();
  const results = await Promise.allSettled([a, b]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("uncertain provider work remains blocked rather than automatically replayed", async (t) => {
  const c = await setup(t);
  await c.action("research", research);
  await assert.rejects(
    c.action("draft", async () => {
      throw Error("timeout");
    }),
  );
  assert.equal(c.w.get("review-1").pending.state, "unconfirmed");
  await assert.rejects(c.action("draft", async () => script));
});
test("local render failure has explicit recovery and preserves accepted audio", async (t) => {
  const c = await ready(t);
  await c.action("scenes", plan);
  await assert.rejects(
    c.action("render", async () => {
      throw Error("Chrome failed");
    }),
  );
  const p = c.w.get("review-1");
  await c.action("recover", p.pending.token);
  assert.equal(c.w.get("review-1").state, "scenes_ready");
  assert.equal(c.w.get("review-1").audioApproval, p.audioApproval);
});

test("regeneration preserves previous approved artifacts and generation provenance", async (t) => {
  const c = await ready(t);
  const previous = c.w.get("review-1");
  await c.action("draft", async () => ({
    parsed: script,
    provenance: { providerId: "test", model: "test" },
  }));
  const current = c.w.get("review-1");
  assert.deepEqual(current.scriptGeneration, {
    providerId: "test",
    model: "test",
  });
  assert.ok(current.history.some((p) => p.audio?.hash === previous.audio.hash));
  assert.equal(current.audio, null);
  assert.equal(current.scriptApproval, null);
});
test("tampered accepted audio prevents the renderer from being invoked", async (t) => {
  const c = await ready(t);
  await c.action("scenes", plan);
  const audio = await c.w.load(c.w.get("review-1").audio);
  await writeFile(audio.path, "tampered");
  let called = false;
  await assert.rejects(
    c.action("render", async () => {
      called = true;
    }),
    /fingerprint mismatch/,
  );
  assert.equal(called, false);
});
