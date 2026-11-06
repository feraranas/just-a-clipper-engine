import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sha256Canonical } from "../canonical-json.mjs";
import { researchSchema, validateScript, scriptText } from "./contracts.mjs";
import { validateScenePlan } from "../../src/Explainer/catalog.mjs";
import { validateMouthCues } from "../../src/PresenterDemo/mouth-timing.mjs";
import { deriveSceneTiming } from "../../src/PresenterDemo/scene-timing.mjs";
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
export function productionView(record) {
  const p = record.production ?? { revision: 0, state: "selected" };
  return {
    reviewId: record.reviewId,
    selectedCandidate: record.selection,
    ...p,
  };
}
export function createExplainerWorkflow({ store, root }) {
  const selected = (id) => {
    const r = store.get(id);
    if (r?.state !== "selected" || !r.selection)
      throw Error("Select a candidate before video production");
    return r;
  };
  const dir = (id) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error("Invalid review ID");
    return join(root, "explainers", id);
  };
  const artifact = async (id, kind, value) => {
    const hash = sha256Canonical(value);
    const folder = dir(id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${kind}-${hash}.json`);
    try {
      await writeFile(path, JSON.stringify(value, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (sha256Canonical(await readJson(path)) !== hash)
        throw Error("Artifact fingerprint mismatch");
    }
    return { hash, path };
  };
  const load = async (ref) => {
    if (!ref) throw Error("Required stage is missing");
    const value = await readJson(ref.path);
    if (sha256Canonical(value) !== ref.hash)
      throw Error("Artifact fingerprint mismatch");
    return value;
  };
  const mutate = (r, revision, fn) => {
    const p = r.production ?? { revision: 0, state: "selected", history: [] };
    if (p.revision !== revision) throw Error("Stale production revision");
    if (p.pending)
      throw Error("A previous attempt needs inspection; no automatic retry");
    return store.update(r.reviewId, sha256Canonical(r), (c) => ({
      ...c,
      production: { ...fn(p), revision: p.revision + 1 },
    }));
  };
  const historyOf = (p) => {
    const { history = [], ...previous } = p;
    return [...history, previous];
  };
  const attempt = async (id, revision, stage, run) => {
    const r = selected(id);
    const prior = r.production ?? {};
    if (stage === "drafting_script") await load(prior.research);
    if (
      ["preparing_narration", "planning_scenes", "rendering"].includes(stage)
    ) {
      await load(prior.script);
      if (prior.scriptApproval !== prior.script.hash)
        throw Error("Approve the exact script first");
    }
    if (["planning_scenes", "rendering"].includes(stage)) {
      const audio = await load(prior.audio);
      if (
        prior.audioApproval !== audio.sha256 ||
        audio.scriptHash !== prior.script.hash
      )
        throw Error("Accept matching narration first");
    }
    if (stage === "rendering") await load(prior.plan);
    const token = randomUUID();
    const locked = mutate(r, revision, (p) => ({
      ...p,
      history: historyOf(p),
      lastError: null,
      pending: { token, stage, state: "started", ownerPid: process.pid },
      state: stage,
    }));
    try {
      const changes = await run(locked.production, join(dir(id), token));
      return productionView(
        store.update(id, sha256Canonical(locked), (c) => ({
          ...c,
          production: {
            ...c.production,
            ...changes,
            pending: null,
            revision: c.production.revision + 1,
          },
        })),
      );
    } catch (error) {
      store.update(id, sha256Canonical(locked), (c) => ({
        ...c,
        production: {
          ...c.production,
          pending: { token, stage, state: "unconfirmed" },
          lastError:
            "Attempt did not finish. Inspect saved output before recovery.",
          revision: c.production.revision + 1,
        },
      }));
      throw error;
    }
  };
  return {
    get: (id) => productionView(selected(id)),
    load,
    dir,
    async research(id, revision, input) {
      const r = selected(id);
      const value = researchSchema.parse(input);
      const ref = await artifact(id, "research", value);
      return productionView(
        mutate(r, revision, (p) => ({
          revision: p.revision,
          state: "research_saved",
          research: ref,
          history: historyOf(p),
        })),
      );
    },
    async script(id, revision, input) {
      const r = selected(id);
      const research = await load(r.production?.research);
      const value = validateScript(input, research);
      const ref = await artifact(id, "script", value);
      return productionView(
        mutate(r, revision, (p) => ({
          revision: p.revision,
          state: "awaiting_script_approval",
          research: p.research,
          script: ref,
          history: historyOf(p),
        })),
      );
    },
    async draft(id, revision, generate) {
      return attempt(id, revision, "drafting_script", async (p) => {
        const research = await load(p.research);
        const r = selected(id);
        const candidate = r.review.candidates.find(
          (c) => c.candidateId === r.selection,
        );
        const generated = await generate({ candidate, research });
        const value = validateScript(generated.parsed ?? generated, research);
        return {
          script: await artifact(id, "script", value),
          scriptGeneration: generated.provenance ?? null,
          scriptApproval: null,
          audio: null,
          audioApproval: null,
          plan: null,
          render: null,
          state: "awaiting_script_approval",
        };
      });
    },
    async approveScript(id, revision, hash) {
      const r = selected(id);
      await load(r.production?.script);
      if (hash !== r.production.script.hash)
        throw Error("Script approval fingerprint is stale");
      return productionView(
        mutate(r, revision, (p) => ({
          ...p,
          scriptApproval: hash,
          state: "script_approved",
        })),
      );
    },
    async narration(id, revision, prepare) {
      return attempt(id, revision, "preparing_narration", async (p, folder) => {
        if (p.scriptApproval !== p.script?.hash)
          throw Error("Approve the exact script before narration");
        const script = await load(p.script);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const audio = await prepare({ script, folder });
        const bytes = await readFile(audio.path);
        if (hashBytes(bytes) !== audio.sha256)
          throw Error("Narration audio fingerprint mismatch");
        if (
          !Number.isFinite(audio.duration) ||
          audio.duration <= 0 ||
          audio.duration > 180 ||
          !Array.isArray(audio.words) ||
          audio.words.some((w, i) => i && w.start < audio.words[i - 1].end)
        )
          throw Error("Invalid narration timing");
        validateMouthCues(audio.mouthCues, audio.duration);
        deriveSceneTiming(script.segments, audio.words, audio.duration);
        const saved = join(folder, "accepted-source.mp3");
        await copyFile(audio.path, saved);
        return {
          audio: await artifact(id, "audio", {
            ...audio,
            path: saved,
            scriptHash: p.script.hash,
          }),
          audioApproval: null,
          plan: null,
          render: null,
          state: "awaiting_narration_acceptance",
        };
      });
    },
    async acceptNarration(id, revision, hash) {
      const r = selected(id);
      const audio = await load(r.production?.audio);
      if (
        r.production.scriptApproval !== audio.scriptHash ||
        hash !== audio.sha256
      )
        throw Error("Narration approval fingerprint is stale");
      return productionView(
        mutate(r, revision, (p) => ({
          ...p,
          audioApproval: hash,
          state: "narration_accepted",
        })),
      );
    },
    async scenes(id, revision, input) {
      const r = selected(id),
        p = r.production;
      const script = await load(p?.script),
        audio = await load(p?.audio);
      if (
        p.scriptApproval !== p.script.hash ||
        p.audioApproval !== audio.sha256 ||
        audio.scriptHash !== p.script.hash
      )
        throw Error("Accept matching script and audio before planning scenes");
      const plan = validateScenePlan(input, script);
      const ref = await artifact(id, "scenes", plan);
      return productionView(
        mutate(r, revision, (p) => ({
          ...p,
          history: historyOf(p),
          plan: ref,
          planGeneration: null,
          render: null,
          state: "scenes_ready",
        })),
      );
    },
    async plan(id, revision, generate) {
      return attempt(id, revision, "planning_scenes", async (p) => {
        const script = await load(p.script),
          audio = await load(p.audio);
        if (
          p.scriptApproval !== p.script.hash ||
          p.audioApproval !== audio.sha256 ||
          audio.scriptHash !== p.script.hash
        )
          throw Error("Accept narration before scene planning");
        const generated = await generate({ script, duration: audio.duration });
        const plan = validateScenePlan(generated.parsed ?? generated, script);
        return {
          plan: await artifact(id, "scenes", plan),
          planGeneration: generated.provenance ?? null,
          render: null,
          state: "scenes_ready",
        };
      });
    },
    async render(id, revision, render) {
      return attempt(id, revision, "rendering", async (p, folder) => {
        const script = await load(p.script),
          audio = await load(p.audio),
          plan = await load(p.plan);
        if (
          p.scriptApproval !== p.script.hash ||
          p.audioApproval !== audio.sha256 ||
          audio.scriptHash !== p.script.hash
        )
          throw Error("Approvals are stale");
        if (hashBytes(await readFile(audio.path)) !== audio.sha256)
          throw Error("Narration audio fingerprint mismatch");
        validateScenePlan(plan, script);
        const timing = deriveSceneTiming(
          script.segments,
          audio.words,
          audio.duration,
        );
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const output = await render({
          script,
          audio,
          scenes: plan.scenes.map((s, i) => ({ ...s, ...timing.segments[i] })),
          folder,
        });
        return {
          render: await artifact(id, "render", {
            ...output,
            scriptHash: p.script.hash,
            audioSha256: audio.sha256,
            sceneHash: p.plan.hash,
          }),
          state: "rendered",
        };
      });
    },
    async recover(id, revision, token) {
      const r = selected(id),
        p = r.production;
      if (p?.revision !== revision || p.pending?.token !== token)
        throw Error("Recovery attempt is stale");
      if (p.pending.state === "started" && p.pending.ownerPid) {
        try {
          process.kill(p.pending.ownerPid, 0);
          throw Error("Render worker is still running");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      if (p.pending.stage !== "rendering")
        throw Error(
          "Paid or generation attempts require manual output inspection; automatic retry is disabled",
        );
      return productionView(
        store.update(id, sha256Canonical(r), (c) => ({
          ...c,
          production: {
            ...p,
            pending: null,
            state: "scenes_ready",
            revision: revision + 1,
          },
        })),
      );
    },
  };
}
export async function importNarration(directory, script) {
  const source = resolve(directory);
  const request = await readJson(join(source, "request.json"));
  const outcome = await readJson(join(source, "outcome.json"));
  const equal = (s) => s.trim().replace(/\s+/g, " ");
  if (equal(request.request.text) !== equal(scriptText(script)))
    throw Error("Saved narration does not match approved script");
  if (outcome.state !== "completed")
    throw Error("Narration request is not completed");
  const path = join(source, "narration.mp3");
  if (hashBytes(await readFile(path)) !== outcome.audioSha256)
    throw Error("Narration audio fingerprint mismatch");
  const timing = await readJson(join(source, "timing.json"));
  const a = timing.normalized_alignment ?? timing.alignment;
  if (
    !a?.characters?.length ||
    a.characters.length !== a.character_start_times_seconds?.length ||
    a.characters.length !== a.character_end_times_seconds?.length
  )
    throw Error("Invalid narration alignment");
  const words = [];
  let text = "",
    start = 0,
    end = 0;
  for (let i = 0; i < a.characters.length; i++) {
    if (/\s/.test(a.characters[i])) {
      if (text) words.push({ text, start, end });
      text = "";
    } else {
      if (!text) start = a.character_start_times_seconds[i];
      text += a.characters[i];
      end = a.character_end_times_seconds[i];
    }
  }
  if (text) words.push({ text, start, end });
  const duration = Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        path,
      ],
      { encoding: "utf8", timeout: 15000 },
    ),
  );
  const mouth = await readJson(join(source, "mouth-cues.json"));
  return {
    path,
    sha256: outcome.audioSha256,
    duration,
    words,
    mouthCues: mouth.mouthCues,
    voiceId: request.voiceId,
  };
}
