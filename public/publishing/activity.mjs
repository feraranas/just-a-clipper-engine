const stages = {
  pipeline: "Pipeline run",
  "transcript-sync": "Video analysis",
  "render-and-queue": "Rendering and queueing",
  "videos-pending": "Videos awaiting analysis",
  transcript: "Fetch transcript",
  selection: "Select moments",
  jev: "Evaluate and rank with Jev",
  heatmap: "Read YouTube heatmap",
  "video-analysis": "Video analysis",
  assets: "Prepare clip assets",
  render: "Render vertical clip",
  queue: "Add clip to approval queue",
};
const outcomes = {
  started: "started",
  completed: "completed",
  failed: "failed",
  partial: "finished with failures",
};

export const describeEvent = (event) => {
  const name = stages[event.stage] ?? String(event.stage ?? "Pipeline event");
  const count = Number.isFinite(event.count)
    ? ` · ${event.count} ${event.stage === "videos-pending" ? "videos" : "clips"}`
    : "";
  return `${name} — ${outcomes[event.status] ?? event.status ?? "unknown"}${count}`;
};

export const groupRuns = (events) => {
  const runs = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || !event.stage || !event.status)
      continue;
    const id = String(event.runId ?? "legacy");
    if (!runs.has(id)) runs.set(id, { id, events: [] });
    runs.get(id).events.push(event);
  }
  // API order is newest-first; each run's terminal displays in occurrence order.
  return [...runs.values()].map((run) => ({
    ...run,
    events: run.events.reverse(),
  }));
};

export const runState = (events, now = Date.now()) => {
  const terminal = [...events]
    .reverse()
    .find(
      (event) =>
        event.stage === "pipeline" &&
        ["completed", "failed", "partial"].includes(event.status),
    );
  if (terminal) return terminal.status;
  const last = events.at(-1);
  if (!last) return "empty";
  const age = now - Date.parse(last.timestamp);
  if (!Number.isFinite(age) || age > 10 * 60 * 1000 || age < -60000)
    return "unknown";
  return "running";
};

// Schedule after completion, not on an interval: slow requests never overlap.
export const createLogPoller = ({
  load,
  onData,
  onError,
  visible = () => true,
  schedule = setTimeout,
  cancel = clearTimeout,
}) => {
  let stopped = false;
  let busy = false;
  let timer;
  let controller;
  const refresh = async () => {
    if (stopped || busy) return;
    cancel(timer);
    if (!visible()) {
      timer = schedule(refresh, 2000);
      return;
    }
    busy = true;
    controller = new AbortController();
    const deadline = schedule(() => controller.abort(), 10000);
    try {
      const events = await load(controller.signal);
      if (!stopped) onData(events);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      cancel(deadline);
      busy = false;
      if (!stopped) timer = schedule(refresh, 2000);
    }
  };
  return {
    refresh,
    stop: () => {
      stopped = true;
      cancel(timer);
      controller?.abort();
    },
  };
};

const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = String(text);
  if (className) result.className = className;
  return result;
};
const localTime = (timestamp) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
};

export const initializeActivity = (root, load) => {
  const list = root.querySelector("#pipeline-log-list");
  const selector = root.querySelector("#log-run");
  const connection = root.querySelector("#log-connection");
  const latest = root.querySelector("#log-latest");
  const scroll = root.querySelector("#log-scroll");
  const follow = root.querySelector("#log-follow");
  const count = root.querySelector("#log-count");
  const refresh = root.querySelector("#refresh-logs");
  if (
    ![list, selector, connection, latest, scroll, follow, count, refresh].every(
      Boolean,
    )
  )
    return () => {};
  let events = [];
  let signature = "";
  let failed = false;
  let previousState;
  const render = () => {
    const runs = groupRuns(events);
    const run = selector.value
      ? runs.find(({ id }) => id === selector.value)
      : runs[0];
    const selected = run?.events ?? [];
    const state = runState(selected);
    previousState = state;
    scroll.dataset.state = state;
    const stateLabel = {
      completed: "Completed",
      partial: "Finished with failures",
      failed: "Failed",
      running: "Recent activity · awaiting completion",
      unknown: "Completion not recorded · no recent updates",
      empty: "No recorded events",
    }[state];
    latest.textContent = selected.length
      ? `${stateLabel} · ${describeEvent(selected.at(-1))}`
      : "Logs will appear here after a pipeline run. Older runs may be outside the recent window.";
    count.textContent = `${selected.length} events`;
    const top = scroll.scrollTop;
    const expanded = new Set(
      [...list.querySelectorAll("details[open]")].map(
        (item) => item.dataset.key,
      ),
    );
    const rows = selected.map((event) => {
      const severity = ["failed", "partial"].includes(event.status)
        ? "error"
        : event.status === "completed"
          ? "success"
          : "progress";
      const row = node("li", undefined, `log-row ${severity}`);
      const time = node("time", localTime(event.timestamp), "log-time");
      if (event.timestamp) {
        time.dateTime = event.timestamp;
        time.title = event.timestamp;
      }
      const content = node("div", undefined, "log-content");
      content.append(node("span", describeEvent(event), "log-message"));
      const context = [
        event.videoId && `Video ${event.videoId}`,
        event.clipPackageId !== undefined && `Clip ${event.clipPackageId}`,
        Number.isFinite(event.durationMs) &&
          `${(event.durationMs / 1000).toFixed(1)}s`,
      ].filter(Boolean);
      if (context.length)
        content.append(node("span", context.join(" · "), "log-context"));
      const details = node("details", undefined, "log-details");
      details.dataset.key = JSON.stringify([
        event.timestamp,
        event.runId,
        event.stage,
        event.status,
        event.clipPackageId,
        event.videoId,
      ]);
      details.open = expanded.has(details.dataset.key);
      details.append(node("summary", "Event details"));
      const metadata = node("dl");
      for (const key of [
        "runId",
        "videoId",
        "clipPackageId",
        "treatmentId",
        "packageVersion",
        "errorCode",
        "durationMs",
      ]) {
        if (event[key] !== undefined)
          metadata.append(node("dt", key), node("dd", event[key]));
      }
      details.append(metadata);
      content.append(details);
      row.append(time, content);
      return row;
    });
    list.replaceChildren(
      ...(rows.length
        ? rows
        : [node("li", "No events in this view.", "log-empty")]),
    );
    if (follow.checked) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = top;
  };
  const updateRuns = () => {
    const selected = selector.value;
    const runs = groupRuns(events);
    const options = [node("option", "Latest run")];
    options[0].value = "";
    for (const run of runs) {
      const option = node(
        "option",
        `${localTime(run.events[0]?.timestamp)} · ${run.id === "legacy" ? "Legacy events" : run.id.slice(0, 12)}`,
      );
      option.value = run.id;
      options.push(option);
    }
    if (selected && !runs.some(({ id }) => id === selected)) {
      const option = node(
        "option",
        "Selected run is outside the recent window",
      );
      option.value = selected;
      options.push(option);
    }
    selector.replaceChildren(...options);
    selector.value = selected;
  };
  const poller = createLogPoller({
    load,
    visible: () => !document.hidden,
    onData: (next) => {
      if (!Array.isArray(next)) throw new Error("Invalid logs response");
      connection.textContent = `Connected · checked ${new Date().toLocaleTimeString()}`;
      connection.dataset.state = "connected";
      const nextSignature = JSON.stringify(next);
      const selected = groupRuns(next).find((run, index) =>
        selector.value ? run.id === selector.value : index === 0,
      );
      if (
        failed ||
        nextSignature !== signature ||
        previousState !== runState(selected?.events ?? [])
      ) {
        events = next;
        signature = nextSignature;
        failed = false;
        updateRuns();
        render();
      }
    },
    onError: () => {
      failed = true;
      connection.textContent =
        "Connection unavailable · showing last received events · retrying";
      connection.dataset.state = "error";
    },
  });
  const onSelect = () => render();
  const onFollow = () => {
    if (follow.checked) scroll.scrollTop = scroll.scrollHeight;
  };
  const onScroll = () => {
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 48)
      follow.checked = false;
  };
  const onVisible = () => {
    if (!document.hidden) poller.refresh();
  };
  const onRefresh = () => poller.refresh();
  selector.addEventListener("change", onSelect);
  follow.addEventListener("change", onFollow);
  scroll.addEventListener("scroll", onScroll);
  refresh.addEventListener("click", onRefresh);
  document.addEventListener("visibilitychange", onVisible);
  poller.refresh();
  return () => {
    poller.stop();
    selector.removeEventListener("change", onSelect);
    follow.removeEventListener("change", onFollow);
    scroll.removeEventListener("scroll", onScroll);
    refresh.removeEventListener("click", onRefresh);
    document.removeEventListener("visibilitychange", onVisible);
  };
};
