import { Caption } from "@remotion/captions";
import React from "react";
import { Easing, interpolate, interpolateColors } from "remotion";
import { msToFrame } from "../helpers/ms-to-frame";

export const Word: React.FC<{
  readonly item: Caption;
  readonly frame: number;
  readonly transcriptionColor: string;
}> = ({ item, frame, transcriptionColor }) => {
  const translateY = interpolate(
    frame,
    [msToFrame(item.startMs), msToFrame(item.startMs) + 6],
    [0.08, 0],
    {
      easing: Easing.out(Easing.quad),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <span
      style={{
        display: "inline-block",
        whiteSpace: "pre",
        translate: `0 ${translateY}em`,
        color: interpolateColors(
          frame,
          [msToFrame(item.startMs), msToFrame(item.startMs) + 6],
          ["#6B6B6B", transcriptionColor],
        ),
      }}
    >
      {item.text}
    </span>
  );
};
