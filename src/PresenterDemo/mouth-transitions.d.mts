export type MouthCue = { start: number; end: number; value: string };
export const mouthPoses: Readonly<
  Record<string, { target: number; enter: number; leave: number }>
>;
export function mouthPoseAt(
  cues: MouthCue[],
  frame: number,
  fps: number,
): number;
