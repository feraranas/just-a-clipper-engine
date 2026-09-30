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

const itemPath = (itemId, action) =>
  `/api/items/${encodeURIComponent(itemId)}/${action}`;

export const loadQueue = async (fetchImpl) => {
  const response = await fetchImpl("/api/items");
  return normalizeQueuePayload(await parseResponse(response));
};

export const loadLogs = async (fetchImpl, limit = 50) => {
  const response = await fetchImpl("/api/logs?limit=" + limit);
  const payload = await parseResponse(response);
  if (!payload || !Array.isArray(payload.events)) throw new Error("Invalid logs payload");
  return payload.events;
};

export const saveCaption = (fetchImpl, itemId, caption) =>
  mutationRequest(fetchImpl, itemPath(itemId, "caption"), { caption });

export const approveItem = (fetchImpl, itemId, scheduledAt) =>
  mutationRequest(fetchImpl, itemPath(itemId, "approve"), { scheduledAt });

export const rejectItem = (fetchImpl, itemId, reason) =>
  mutationRequest(fetchImpl, itemPath(itemId, "reject"), { reason });

const formatDate = (value) => {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const element = (tag, properties = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (key === "textContent") node.textContent = value;
    else if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
};

const renderItem = (item, reload, setMessage) => {
  const metadata = formatItemMetadata(item);
  const card = element("article", { className: "queue-card" });
  const heading = element("div", { className: "queue-card-heading" }, [
    element("div", {}, [
      element("h2", { textContent: metadata.title }),
      element("p", { className: "queue-state", textContent: metadata.state }),
    ]),
    element("time", { textContent: formatDate(metadata.createdAt) }),
  ]);
  const preview = element("video", {
    className: "queue-preview",
    controls: "",
    preload: "metadata",
    src: buildPreviewUrl(item.id),
  });
  preview.addEventListener("error", () => {
    setMessage(`Preview unavailable for ${metadata.title}`, "error");
  });
  const details = element("p", {
    className: "queue-details",
    textContent: `Artifact: ${metadata.artifactHash}`,
  });
  const caption = element("textarea", {
    className: "caption-input",
    rows: "4",
    placeholder: "Caption",
  });
  caption.value = item.caption ?? "";
  const schedule = element("input", {
    className: "schedule-input",
    type: "datetime-local",
  });
  const rejectionReason = element("input", {
    className: "rejection-input",
    type: "text",
    placeholder: "Reason for rejection",
  });
  const save = element("button", { type: "button", textContent: "Save caption" });
  const approve = element("button", {
    type: "button",
    className: "button-primary",
    textContent: "Approve + schedule",
  });
  const reject = element("button", {
    type: "button",
    className: "button-danger",
    textContent: "Reject",
  });
  const controls = element("div", { className: "queue-controls" }, [
    element("label", { textContent: "Caption" }), caption, save,
    element("label", { textContent: "Schedule" }), schedule, approve,
    rejectionReason, reject,
  ]);
  const run = async (action) => {
    for (const button of [save, approve, reject]) button.disabled = true;
    try {
      await action();
      await reload();
      setMessage("Queue updated", "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      for (const button of [save, approve, reject]) button.disabled = false;
    }
  };
  save.addEventListener("click", () => run(() => saveCaption(fetch, item.id, caption.value)));
  approve.addEventListener("click", () => {
    if (!schedule.value) {
      setMessage("Choose a schedule before approving", "error");
      return;
    }
    return run(() => approveItem(fetch, item.id, new Date(schedule.value).toISOString()));
  });
  reject.addEventListener("click", () => {
    if (!rejectionReason.value.trim()) {
      setMessage("Enter a reason before rejecting", "error");
      return;
    }
    return run(() => rejectItem(fetch, item.id, rejectionReason.value.trim()));
  });
  card.append(heading, preview, details, controls);
  return card;
};

export const initializePublishingPage = (root = document) => {
  const list = root.querySelector("#queue-list");
  const message = root.querySelector("#queue-message");
  const refresh = root.querySelector("#refresh-queue");
  const refreshLogs = root.querySelector("#refresh-logs");
  const logList = root.querySelector("#pipeline-log-list");
  if (!list || !message || !refresh || !refreshLogs || !logList) return;
  const setMessage = (text, kind = "") => {
    message.textContent = text;
    message.className = `queue-message ${kind}`.trim();
  };
  const reload = async () => {
    setMessage("Loading queue…");
    try {
      const items = await loadQueue(fetch);
      list.replaceChildren();
      if (items.length === 0) {
        list.append(element("p", { className: "empty-state", textContent: "No publishing candidates yet." }));
      } else {
        for (const item of items) list.append(renderItem(item, reload, setMessage));
      }
      setMessage(`${items.length} candidate${items.length === 1 ? "" : "s"}`);
    } catch (error) {
      list.replaceChildren();
      setMessage(error.message, "error");
    }
  };
  const reloadLogs = async () => {
    try {
      const events = await loadLogs(fetch);
      logList.replaceChildren(...events.map((event) => element("li", { textContent: [event.timestamp || "", event.stage || "unknown", "-", event.status || "unknown"].join(" ") })));
    } catch (error) {
      logList.replaceChildren(element("li", { textContent: error.message }));
    }
  };
  refresh.addEventListener("click", reload);
  refreshLogs.addEventListener("click", reloadLogs);
  reload();
  reloadLogs();
};

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => initializePublishingPage());
}
