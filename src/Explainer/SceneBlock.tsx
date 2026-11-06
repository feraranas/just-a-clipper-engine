import React from "react";
import { interpolate } from "remotion";
import type { Scene } from "./catalog.mjs";
const ink = "#f7f4e9",
  amber = "#ffcf7b",
  blue = "#90c6ff";
const progress = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
export const SceneBlock: React.FC<{
  scene: Scene;
  frame: number;
  frames: number;
}> = ({ scene, frame, frames }) => {
  const phase = frame / Math.max(1, frames);
  const reveal = (i: number) => progress(frame, i * 6, i * 6 + 10);
  return (
    <div style={{ position: "relative", height: 500 }}>
      <div
        style={{
          fontSize: 32,
          lineHeight: 1.1,
          fontWeight: 700,
          marginBottom: 30,
          color: ink,
        }}
      >
        {scene.title}
      </div>
      {scene.kind === "comparison" && (
        <div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
          {scene.items.map((text, i) => (
            <div
              key={i}
              style={{
                width: "50%",
                height: 280,
                background: i ? "#183a43" : "#293148",
                border: `2px solid ${i ? blue : "#58627d"}`,
                borderRadius: 24,
                padding: 24,
                opacity: reveal(i),
                translate: `0 ${20 * (1 - reveal(i))}px`,
              }}
            >
              <div
                style={{
                  fontSize: 17,
                  letterSpacing: 3,
                  color: i ? blue : amber,
                  marginBottom: 22,
                }}
              >
                0{i + 1}
              </div>
              <svg
                width="64"
                height="64"
                viewBox="0 0 64 64"
                style={{ marginBottom: 20 }}
              >
                <rect
                  x="5"
                  y="5"
                  width="54"
                  height="54"
                  rx="14"
                  stroke={i ? blue : amber}
                  strokeWidth="2"
                  fill="none"
                />
                {i ? (
                  <path
                    d="M18 33 L28 43 L47 22"
                    stroke={blue}
                    strokeWidth="4"
                    fill="none"
                  />
                ) : (
                  <>
                    <path
                      d="M18 23 H45 M18 32 H40 M18 41 H35"
                      stroke={amber}
                      strokeWidth="3"
                    />
                  </>
                )}
              </svg>
              <div style={{ fontSize: 27, fontWeight: 600, lineHeight: 1.25 }}>
                {text}
              </div>
            </div>
          ))}
        </div>
      )}
      {scene.kind === "process" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {scene.items.map((text, i) => {
            const active = Math.min(
              scene.items.length - 1,
              Math.floor(phase * scene.items.length),
            );
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  minHeight: 67,
                  padding: "13px 20px",
                  background: active === i ? "#263e4d" : "#222b3d",
                  border: `1px solid ${active === i ? blue : "#3a4559"}`,
                  borderRadius: 16,
                  opacity: reveal(i),
                  translate: `${12 * (1 - reveal(i))}px 0`,
                }}
              >
                <div
                  style={{
                    borderRadius: 30,
                    background: active === i ? blue : "#3a4559",
                    color: active === i ? "#142338" : ink,
                    width: 36,
                    height: 36,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 18,
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ fontSize: 25, fontWeight: 600 }}>{text}</div>
              </div>
            );
          })}
        </div>
      )}
      {scene.kind === "branch" && (
        <div
          style={{
            border: "1px solid #48526b",
            borderRadius: 24,
            background: "#222b3d",
            padding: "22px 12px",
          }}
        >
          <div
            style={{
              fontSize: 16,
              letterSpacing: 2,
              color: amber,
              marginLeft: 12,
            }}
          >
            SHARED HISTORY · ILLUSTRATION
          </div>
          <svg width="100%" height="290" viewBox="0 0 600 290">
            <path d="M65 100 H530" stroke="#657089" strokeWidth="4" />
            {scene.items.map((t, i) => (
              <g
                key={i}
                opacity={
                  i > 1
                    ? 1 - progress(frame, frames * 0.35, frames * 0.65) * 0.7
                    : 1
                }
              >
                <circle
                  cx={65 + i * 155}
                  cy="100"
                  r="21"
                  fill={i < 2 ? blue : "#f39b91"}
                />
                <text
                  x={65 + i * 155}
                  y="107"
                  textAnchor="middle"
                  fontSize="18"
                  fill="#162235"
                >
                  {String.fromCharCode(65 + i)}
                </text>
                <text
                  x={65 + i * 155}
                  y="151"
                  textAnchor="middle"
                  fontSize="17"
                  fill={ink}
                >
                  {t.length > 18 ? t.slice(0, 17) + "…" : t}
                </text>
              </g>
            ))}
            <path
              d="M220 100 Q275 100 310 220 H530"
              stroke={amber}
              strokeWidth="5"
              fill="none"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={
                1 - progress(frame, frames * 0.25, frames * 0.6)
              }
            />
            <circle
              cx="530"
              cy="220"
              r="20"
              fill={amber}
              opacity={progress(frame, frames * 0.55, frames * 0.65)}
            />
            <text
              x="385"
              y="264"
              fill={amber}
              fontSize="18"
              textAnchor="middle"
            >
              Replacement history
            </text>
          </svg>
        </div>
      )}
    </div>
  );
};
