import { mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export function renderExplainer({ projectRoot, assetsDir, browser }) {
  return async ({ script, audio, scenes, folder }) => {
    const relative = `generated/explainer-${basename(folder)}`,
      stage = join(projectRoot, "public", relative);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      await copyFile(audio.path, join(stage, "narration.mp3"));
      for (const name of [
        "happy-sheet.png",
        "blink-sheet.png",
        "mouths-20.png",
      ])
        await copyFile(join(assetsDir, name), join(stage, name));
      const props = {
        title: script.title,
        audioSrc: `${relative}/narration.mp3`,
        duration: audio.duration,
        scenes,
        mouthCues: audio.mouthCues,
        words: audio.words,
        presenterAssets: `${relative}/`,
      };
      const propsPath = join(folder, "props.json");
      await writeFile(propsPath, JSON.stringify(props), { mode: 0o600 });
      const output = join(folder, "video.mp4");
      execFileSync(
        join(projectRoot, "node_modules/.bin/remotion"),
        [
          "render",
          "src/index.ts",
          "AnimatedExplainer",
          output,
          "--props",
          propsPath,
          "--concurrency=2",
          "--log=error",
          ...(browser ? [`--browser-executable=${browser}`] : []),
        ],
        {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 600000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,nb_frames",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            output,
          ],
          { encoding: "utf8", timeout: 15000 },
        ),
      );
      const video = probe.streams.find((s) => s.codec_type === "video");
      if (
        video?.width !== 720 ||
        video.height !== 1280 ||
        !probe.streams.some((s) => s.codec_type === "audio") ||
        Number(video.nb_frames) !== Math.ceil(audio.duration * 24)
      )
        throw Error("Rendered video failed media checks");
      return {
        path: output,
        sha256: createHash("sha256")
          .update(await readFile(output))
          .digest("hex"),
        duration: Number(probe.format.duration),
        frames: Number(video.nb_frames),
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };
}
