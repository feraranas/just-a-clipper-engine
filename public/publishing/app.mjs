export const buildPreviewUrl = (itemId) => {
  if (typeof itemId !== "string" || itemId.trim() === "") {
    throw new Error("item ID is required");
  }
  return `/api/items/${encodeURIComponent(itemId)}/preview`;
};

export const normalizeQueuePayload = (payload) => {
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error("Invalid queue payload");
  }
  return payload.items;
};

export const formatItemMetadata = (item) => ({
  title: item?.title ?? "Untitled artifact",
  state: item?.state ?? "unknown",
  artifactHash: item?.artifactHash ?? "unknown",
  createdAt: item?.createdAt ?? null,
});

const parseResponse = async (response) => {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
    );
  }
  return payload;
};

export const mutationRequest = async (fetchImpl, path, body) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(response);
};
