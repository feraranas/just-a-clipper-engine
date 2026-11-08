import React from "react";
import {
  AbsoluteFill,
  Audio,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBlock } from "./SceneBlock";
import { LikenessPresenter } from "../PresenterDemo/LikenessPresenter";
import type { Scene } from "./catalog.mjs";
export type ExplainerProps = {
  title: string;
  audioSrc: string;
  duration: number;
  scenes: (Scene & { text: string; start: number; end: number })[];
  mouthCues: { start: number; end: number; value: string }[];
  words: { text: string; start: number; end: number }[];
  presenterAssets: string;
};
export const Explainer: React.FC<ExplainerProps> = ({
  title,
  audioSrc,
  scenes,
  mouthCues,
  words,
  presenterAssets,
}) => {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig();
  const seconds = frame / fps;
  const index = Math.max(
    0,
    scenes.findLastIndex((s) => seconds >= s.start),
  );
  const scene = scenes[index];
  const wi = words.findIndex((w) => seconds >= w.start && seconds < w.end);
  const current =
    wi < 0
      ? Math.max(
          0,
          words.findLastIndex((w) => w.start <= seconds),
        )
      : wi;
  const group = words.slice(
    Math.floor(current / 7) * 7,
    Math.floor(current / 7) * 7 + 7,
  );
  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(145deg,#182337,#111b2d)",
        color: "#f7f4e9",
        fontFamily: "Arial, sans-serif",
        padding: 44,
      }}
    >
      <Audio src={staticFile(audioSrc)} />
      <div
        style={{
          fontSize: 15,
          letterSpacing: 4,
          color: "#ffcf7b",
          fontWeight: 700,
        }}
      >
        AGENT ENGINEERING
      </div>
      <div
        style={{
          fontSize: 43,
          lineHeight: 1.12,
          fontWeight: 800,
          marginTop: 20,
          minHeight: 105,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 25, marginBottom: 28 }}>
        {scenes.map((s, i) => (
          <div
            key={s.segmentId}
            style={{
              height: 4,
              flex: 1,
              background: i <= index ? "#90c6ff" : "#35415a",
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 14,
          letterSpacing: 2,
          color: "#9faec7",
          marginBottom: 17,
        }}
      >
        {String(index + 1).padStart(2, "0")} /{" "}
        {String(scenes.length).padStart(2, "0")}
      </div>
      <SceneBlock
        scene={scene}
        frame={frame - Math.floor(scene.start * fps)}
        frames={Math.ceil((scene.end - scene.start) * fps)}
      />
      <div
        style={{
          position: "absolute",
          left: 34,
          top: 760,
          width: 240,
          height: 320,
          overflow: "hidden",
          borderRadius: 28,
          border: "1px solid #45536b",
        }}
      >
        <LikenessPresenter cues={mouthCues} assets={presenterAssets} inset />
      </div>
      <div
        style={{
          position: "absolute",
          left: 300,
          top: 800,
          right: 44,
          fontSize: 28,
          lineHeight: 1.25,
          fontWeight: 700,
          color: "#ffcf7b",
        }}
      >
        {scene.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 300,
          top: 997,
          right: 44,
          color: "#9faec7",
          fontSize: 15,
        }}
      >
        EXPLAINED WITH DIAGRAMS
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          bottom: 45,
          minHeight: 105,
          display: "flex",
          flexWrap: "wrap",
          alignContent: "center",
          justifyContent: "center",
          gap: "4px 7px",
          padding: 18,
          borderRadius: 18,
          background: "#0b1423",
          fontSize: 28,
          lineHeight: 1.35,
        }}
      >
        {group.map((w, i) => (
          <span
            key={i}
            style={{
              color:
                seconds >= w.start && seconds < w.end ? "#ffcf7b" : "#f7f4e9",
            }}
          >
            {w.text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
