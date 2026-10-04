const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);
const YOUTUBE_VIDEO_PATHS = new Set(["shorts", "embed", "live"]);

const codedError = (code, message) => Object.assign(new Error(message), { code });

const canonicalUrlFor = (videoId) =>
  `https://www.youtube.com/watch?v=${videoId}`;

export const parseYouTubeVideoUrl = (input) => {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw codedError("INVALID_URL", "Enter a valid absolute YouTube video URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw codedError("UNSUPPORTED_PROTOCOL", "YouTube URLs must use HTTP or HTTPS.");
  }

  if (
    url.username ||
    url.password ||
    url.port ||
    !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw codedError("INVALID_HOST", "URL host is not a supported YouTube host.");
  }

  const path = url.pathname.split("/").filter(Boolean);
  let videoId;

  if (url.hostname.toLowerCase() === "youtu.be") {
    if (path.length !== 1) {
      throw codedError("UNSUPPORTED_PATH", "URL is not a supported YouTube video path.");
    }
    [videoId] = path;
  } else if (path.length === 1 && path[0] === "watch") {
    const ids = url.searchParams.getAll("v");
    if (ids.length > 1) {
      throw codedError("INVALID_VIDEO_ID", "URL must identify exactly one YouTube video.");
    }
    [videoId] = ids;
  } else if (
    path.length === 2 &&
    YOUTUBE_VIDEO_PATHS.has(path[0])
  ) {
    [, videoId] = path;
  } else {
    throw codedError("UNSUPPORTED_PATH", "URL is not a supported YouTube video path.");
  }

  if (!videoId) {
    throw codedError("MISSING_VIDEO_ID", "YouTube URL does not identify a video.");
  }
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw codedError("INVALID_VIDEO_ID", "YouTube video ID has an invalid format.");
  }

  return { videoId, sourceUrl: canonicalUrlFor(videoId) };
};

export const validateYouTubeMetadata = (metadata, requestedVideoId) => {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.id !== "string" ||
    !VIDEO_ID_PATTERN.test(metadata.id) ||
    typeof metadata.title !== "string" ||
    metadata.title.trim().length === 0
  ) {
    throw codedError("INVALID_METADATA", "YouTube returned incomplete video metadata.");
  }

  if (metadata.id !== requestedVideoId) {
    throw codedError("VIDEO_ID_MISMATCH", "YouTube metadata did not match the requested video.");
  }

  return {
    videoId: metadata.id,
    title: metadata.title.trim(),
    sourceUrl: canonicalUrlFor(metadata.id),
  };
};
