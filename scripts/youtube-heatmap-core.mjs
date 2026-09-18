import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

export const extractHeatmap = (metadata) =>
  (metadata?.heatmap ?? [])
    .map((marker) => ({
      startTime: marker.start_time,
      endTime: marker.end_time,
      value: marker.value,
    }))
    .filter(
      ({startTime, endTime, value}) =>
        Number.isFinite(startTime) &&
        Number.isFinite(endTime) &&
        Number.isFinite(value) &&
        startTime >= 0 &&
        endTime > startTime,
    )
    .sort((left, right) => left.startTime - right.startTime);

const isLocalPeak = (markers, index) => {
  const value = markers[index].value;
  const previous = markers[index - 1]?.value ?? Number.NEGATIVE_INFINITY;
  const next = markers[index + 1]?.value ?? Number.NEGATIVE_INFINITY;

  return value >= previous && value >= next && (value > previous || value > next);
};

const isIndependent = (candidate, selected, minimumSeparationSeconds) =>
  selected.every(
    (clip) =>
      candidate.endTime <= clip.startSeconds - minimumSeparationSeconds ||
      candidate.startTime >= clip.endSeconds + minimumSeparationSeconds,
  );

export const selectTopHeatmapClips = (
  heatmap,
  {maxClips = 1, minimumSeparationSeconds = 20} = {},
) => {
  if (maxClips < 1) {
    return [];
  }

  const localPeaks = heatmap.filter((_, index) => isLocalPeak(heatmap, index));
  const candidates = (localPeaks.length > 0 ? localPeaks : heatmap).toSorted(
    (left, right) => right.value - left.value || left.startTime - right.startTime,
  );
  const selected = [];

  for (const candidate of candidates) {
    if (!isIndependent(candidate, selected, minimumSeparationSeconds)) {
      continue;
    }

    selected.push({
      rank: selected.length + 1,
      startSeconds: candidate.startTime,
      endSeconds: candidate.endTime,
      score: candidate.value,
    });

    if (selected.length === maxClips) {
      break;
    }
  }

  return selected;
};

export const fetchYtDlpMetadata = async (
  url,
  {run = execFileAsync, executable = "yt-dlp"} = {},
) => {
  const {stdout} = await run(
    executable,
    [
      "--no-warnings",
      "--skip-download",
      "--dump-single-json",
      "--no-playlist",
      "--",
      url,
    ],
    {encoding: "utf8", maxBuffer: 64 * 1024 * 1024},
  );

  return JSON.parse(stdout);
};

