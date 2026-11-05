import React from "react";

// The artwork covers only the original closed mouth; Rhubarb selects a shape.
export const OriginalMouth: React.FC<{ shape: string }> = ({ shape }) => {
  const skin = "#db8e5a",
    ink = "#42261b",
    tongue = "#d77a76",
    teeth = "#fff3df";
  const widths: Record<string, number> = {
    B: 8.5,
    C: 8,
    D: 7.7,
    E: 6,
    F: 4,
    G: 8,
    H: 8,
  };
  const heights: Record<string, number> = {
    B: 1.7,
    C: 3.7,
    D: 6,
    E: 4,
    F: 4.5,
    G: 2.7,
    H: 4.5,
  };
  return (
    <svg viewBox="0 0 28 20" width="100%" height="100%">
      <ellipse cx="14" cy="10" rx="13.5" ry="7" fill={skin} />
      {shape === "X" || shape === "A" ? (
        <path
          d={shape === "X" ? "M5 10 Q14 12 23 10" : "M5 10 Q14 9 23 10"}
          fill="none"
          stroke={ink}
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ) : (
        <>
          <ellipse
            cx="14"
            cy="10"
            rx={widths[shape] ?? 7}
            ry={heights[shape] ?? 3}
            fill={ink}
          />
          {["B", "C", "D", "G", "H"].includes(shape) && (
            <path d="M7 8 Q14 7 21 8 L20 9.5 L8 9.5 Z" fill={teeth} />
          )}
          {["C", "D", "H"].includes(shape) && (
            <ellipse cx="14" cy="12" rx="4.5" ry="1.5" fill={tongue} />
          )}
        </>
      )}
    </svg>
  );
};
