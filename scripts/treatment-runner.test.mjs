import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderTreatmentRun } from "./treatment-runner.mjs";

test("renders any registry treatment to its deterministic artifact path", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-runner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    await writeFile(args[3], "rendered media");
  };
  const treatment = {
    id: "future-treatment",
    version: "2",
    compositionId: "FutureComposition",
    output: { extension: "mp4", codec: "h264" },
    requiredAssetRoles: [],
    buildProps: (clipPackage) => ({ title: clipPackage.title }),
  };

  const artifactRelativePath = await renderTreatmentRun(
    {
      clipPackage: {
        videoId: "video-1",
        packageVersion: "v2",
        rank: 3,
        title: "A clip",
        assets: [],
      },
      treatment,
    },
    { projectRoot, runCommand },
  );

  assert.equal(
    artifactRelativePath,
    "out/treatments/future-treatment/2/video-1/v2/clip-3.mp4",
  );
  assert.deepEqual(calls[0], {
    command: "npx",
    args: [
      "remotion",
      "render",
      "FutureComposition",
      join(
        projectRoot,
        "out/treatments/future-treatment/2/video-1/v2/.clip-3.partial.mp4",
      ),
      `--props=${join(projectRoot, "out/treatments/future-treatment/2/video-1/v2/clip-3.props.json")}`,
      "--codec=h264",
    ],
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          projectRoot,
          "out/treatments/future-treatment/2/video-1/v2/clip-3.props.json",
        ),
        "utf8",
      ),
    ),
    { title: "A clip" },
  );
  assert.equal(
    (
      await stat(
        join(
          projectRoot,
          "out/treatments/future-treatment/2/video-1/v2/clip-3.mp4",
        ),
      )
    ).size,
    14,
  );
});

test("does not publish an empty partial render", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-runner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const treatment = {
    id: "audiogram-basic",
    version: "1",
    compositionId: "AudiogramBasic",
    output: { extension: "mp4", codec: "h264" },
    requiredAssetRoles: [],
    buildProps: () => ({}),
  };

  await assert.rejects(
    renderTreatmentRun(
      {
        clipPackage: { videoId: "video-1", packageVersion: "v1", rank: 1 },
        treatment,
      },
      {
        projectRoot,
        runCommand: async (_command, args) => writeFile(args[3], ""),
      },
    ),
    /Rendered artifact is empty/,
  );
});

test("missing required assets stop rendering before the process starts", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-runner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let processCalls = 0;
  await assert.rejects(
    renderTreatmentRun(
      {
        clipPackage: {
          videoId: "video-1",
          packageVersion: "v1",
          rank: 1,
          assets: [],
        },
        treatment: {
          id: "requires-audio",
          version: "1",
          compositionId: "RequiresAudio",
          output: { extension: "mp4", codec: "h264" },
          requiredAssetRoles: ["audio"],
          buildProps: () => ({}),
        },
      },
      {
        projectRoot,
        runCommand: async () => {
          processCalls += 1;
        },
      },
    ),
    /Missing required asset: audio/,
  );
  assert.equal(processCalls, 0);
});

test("rejects navigation render path components before creating treatment output", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-paths-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const validClipPackage = {
    videoId: "video-1",
    packageVersion: "v1",
    rank: 1,
    assets: [],
  };
  const validTreatment = {
    id: "audiogram-basic",
    version: "1",
    compositionId: "AudiogramBasic",
    output: { extension: "mp4", codec: "h264" },
    requiredAssetRoles: [],
    buildProps: () => ({}),
  };

  for (const [target, field, label] of [
    ["clipPackage", "videoId", "video ID"],
    ["clipPackage", "packageVersion", "package version"],
    ["treatment", "id", "treatment ID"],
    ["treatment", "version", "treatment version"],
  ]) {
    for (const value of [".", ".."]) {
      let processCalls = 0;
      const clipPackage = { ...validClipPackage };
      const treatment = { ...validTreatment };
      const subject = target === "clipPackage" ? clipPackage : treatment;
      subject[field] = value;

      await assert.rejects(
        renderTreatmentRun(
          { clipPackage, treatment },
          {
            projectRoot,
            runCommand: async () => {
              processCalls += 1;
              throw new Error("render command should not run");
            },
          },
        ),
        { message: `Invalid ${label}: ${value}` },
      );
      assert.equal(processCalls, 0);
    }
  }

  await assert.rejects(stat(join(projectRoot, "out")), { code: "ENOENT" });
});

test("requires a package version before creating treatment output", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-paths-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let processCalls = 0;

  for (const packageVersion of [undefined, null]) {
    await assert.rejects(
      renderTreatmentRun(
        {
          clipPackage: {
            videoId: "video-1",
            packageVersion,
            rank: 1,
            assets: [],
          },
          treatment: {
            id: "audiogram-basic",
            version: "1",
            compositionId: "AudiogramBasic",
            output: { extension: "mp4", codec: "h264" },
            requiredAssetRoles: [],
            buildProps: () => ({}),
          },
        },
        {
          projectRoot,
          runCommand: async () => {
            processCalls += 1;
          },
        },
      ),
      { message: `Invalid package version: ${packageVersion}` },
    );
  }

  assert.equal(processCalls, 0);
  await assert.rejects(stat(join(projectRoot, "out")), { code: "ENOENT" });
});

test('records resolved selection and artifact hash alongside the rendered video',async(t)=>{
 const projectRoot=await mkdtemp(join(tmpdir(),'manifest-'));t.after(()=>rm(projectRoot,{recursive:true,force:true}));
 const {audiogramBasicTreatment}=await import('./treatment-registry.mjs');
 const {createHash}=await import('node:crypto');
 const clipPackage={videoId:'video-1',packageVersion:'v1',rank:1,title:'Example',assets:['audio','captions','thumbnail'].map(role=>({role,relativePath:`public/${role}.json`}))};
 const output=await renderTreatmentRun({clipPackage,treatment:audiogramBasicTreatment,selection:{templateId:'classic',templateVersion:'1',variationId:'default'}},{projectRoot,runCommand:async(_,args)=>writeFile(args[3],'video')});
 const manifest=JSON.parse(await readFile(join(projectRoot,output.replace(/\.mp4$/,'.manifest.json')),'utf8'));
 assert.deepEqual(manifest.selection,{templateId:'classic',templateVersion:'1',variationId:'default'});
 assert.equal(manifest.artifactHash,createHash('sha256').update('video').digest('hex'));
 assert.equal(manifest.compositionId,'AudiogramBasic');assert.equal(manifest.props.title,'Example');
 assert.equal(manifest.props.visualizer.type,'oscilloscope');
});

test('manifest failure does not return a successful artifact',async(t)=>{
 const projectRoot=await mkdtemp(join(tmpdir(),'manifest-fail-'));t.after(()=>rm(projectRoot,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');
 await mkdir(join(projectRoot,'out/treatments/custom/1/video-1/v1/clip-1.manifest.json'),{recursive:true});
 await assert.rejects(renderTreatmentRun({clipPackage:{videoId:'video-1',packageVersion:'v1',rank:1,assets:[]},treatment:{id:'custom',version:'1',compositionId:'Custom',requiredAssetRoles:[],output:{extension:'mp4',codec:'h264'},buildProps:()=>({})}},{projectRoot,runCommand:async(_,args)=>writeFile(args[3],'video')}));
 await assert.rejects(stat(join(projectRoot,'out/treatments/custom/1/video-1/v1/clip-1.mp4')),{code:'ENOENT'});
});
