import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import cues from "./liam-cues.json";
import { validateMouthCues } from "./mouth-timing.mjs";
import { mouthPoseAt } from "./mouth-transitions.mjs";
const checked = validateMouthCues(cues.mouthCues, cues.duration);
const assets = "generated/presenter-likeness/";
const mouthMask =
  "radial-gradient(ellipse 23% 11% at 51% 57%, black 58%, transparent 100%)";
const eyeMask =
  "radial-gradient(ellipse 38% 9% at 50% 35%, black 70%, transparent 100%)";

export const LikenessPresenter: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cell = mouthPoseAt(checked, frame, fps);
  const blink = frame % 111 >= 75 && frame % 111 <= 77;
  return (
    <div
      style={{
        position: "absolute",
        left: 22,
        top: 720,
        width: 240,
        height: 320,
        overflow: "hidden",
        translate: `0 ${Math.sin((frame / fps) * 1.3) * 1.5}px`,
      }}
    >
      <Img
        src={staticFile(assets + "happy-sheet.png")}
        style={{
          position: "absolute",
          maxWidth: "none",
          width: 720,
          height: 960,
        }}
      />
      {blink && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            maskImage: eyeMask,
            WebkitMaskImage: eyeMask,
          }}
        >
          <Img
            src={staticFile(assets + "blink-sheet.png")}
            style={{
              position: "absolute",
              maxWidth: "none",
              width: 720,
              height: 960,
            }}
          />
        </div>
      )}
      {cell !== 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            maskImage: mouthMask,
            WebkitMaskImage: mouthMask,
          }}
        >
          <Img
            src={staticFile(assets + "mouths-20.png")}
            style={{
              position: "absolute",
              maxWidth: "none",
              width: 1300,
              height: 1040,
              left: -20 - (cell % 5) * 260,
              top: 20 - Math.floor(cell / 5) * 260,
            }}
          />
        </div>
      )}
    </div>
  );
};
