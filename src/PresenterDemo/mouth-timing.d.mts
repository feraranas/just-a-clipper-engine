export type MouthCue = { start: number; end: number; value: string };
export function validateMouthCues(
  cues: MouthCue[],
  duration: number,
): MouthCue[];
export function mouthAt(cues: MouthCue[], seconds: number): string;
