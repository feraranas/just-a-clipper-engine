import { useEffect, useRef, useState } from "react";
import { createRefreshLoop } from "../../public/job-debug/controller.mjs";
import { loadJobs, loadSnapshot, type JobsPage, type Snapshot } from "./api";
import { Badge, dateText, LogTable } from "./LogTable";

function useRefresh<T>(
  key: string,
  load: (key: string, signal: AbortSignal) => Promise<T>,
  paused: boolean,
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState<Date | null>(null);
  const loop = useRef<ReturnType<typeof createRefreshLoop<T>> | null>(null);
  useEffect(() => {
    const current = createRefreshLoop({
      load,
      onData: (value) => {
        setData(value);
        setError("");
        setUpdated(new Date());
      },
      onError: (e) => setError(e.message),
    });
    loop.current = current;
    if (paused || document.hidden) current.pause();
    current.start(key);
    const visibility = () => {
      if (paused || document.hidden) current.pause();
      else current.resume();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      current.stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key, load, paused]);
  return { data, error, updated, refresh: () => loop.current?.refresh() };
}
const recentLoad = (key: string, signal: AbortSignal) =>
  loadJobs(Number(key), signal);
const isJobId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

function JobView({ id }: { id: string }) {
  const [paused, setPaused] = useState(false),
    [eventPages, setEventPages] = useState(1),
    [deliveryPages, setDeliveryPages] = useState(1),
    [tab, setTab] = useState<"events" | "deliveries">("events");
  const result = useRefresh<Snapshot>(
    JSON.stringify([id, eventPages, deliveryPages]),
    loadSnapshot,
    paused,
  );
  const snapshot = result.data;
  return (
    <section className="job-view">
      <div className="job-heading">
        <div>
          <p className="eyebrow">Job details</p>
          <h2>
            {snapshot ? (snapshot.job.title ?? "Untitled job") : "Loading job…"}
          </h2>
          <code className="job-id">{id}</code>
        </div>
        <div className="controls">
          <button onClick={() => setPaused(!paused)}>
            {paused ? "Resume updates" : "Pause updates"}
          </button>
          <button className="subtle" onClick={result.refresh} disabled={paused}>
            Refresh
          </button>
        </div>
      </div>
      <div className="refresh-line" role="status">
        <span
          className={"dot " + (result.error ? "error" : paused ? "paused" : "")}
        />
        {result.error
          ? "Stale · " + result.error
          : paused
            ? "Auto-refresh paused"
            : "Auto-refresh every 2 seconds"}
        {result.updated && (
          <span>Last read {result.updated.toLocaleTimeString()}</span>
        )}
      </div>
      {!snapshot ? (
        <div className="empty">{result.error || "Reading job records…"}</div>
      ) : (
        <>
          <div className="metrics">
            <div>
              <span>Processing</span>
              <Badge value={snapshot.job.status} />
            </div>
            <div>
              <span>Verified artifacts</span>
              <strong>{snapshot.job.artifactCount}</strong>
            </div>
            <div>
              <span>Event capture</span>
              <Badge value={snapshot.job.capture} />
            </div>
            <div>
              <span>Callback delivery</span>
              <Badge value={snapshot.notification.delivery} />
            </div>
          </div>
          <div className="job-facts">
            <span>Created {dateText(snapshot.job.createdAt)}</span>
            <span>Updated {dateText(snapshot.job.updatedAt)}</span>
          </div>
          {snapshot.job.failures.map((f, i) => (
            <p className="notice error-notice" key={i}>
              Clip {f.packageId ?? "—"} · {f.stage} · <code>{f.code}</code>
            </p>
          ))}
          {snapshot.job.summaryIncomplete && (
            <p className="notice">
              The stored result exceeds the summary limit. Some details are
              unavailable.
            </p>
          )}
          {snapshot.job.diagnosticsIncomplete && (
            <p className="notice">
              The worker reported incomplete diagnostics. Some log records or
              captured output may be missing.
            </p>
          )}
          <div className="tabs" role="tablist" aria-label="Job records">
            <button
              role="tab"
              aria-selected={tab === "events"}
              onClick={() => setTab("events")}
            >
              Stage events <span>{snapshot.events.events.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === "deliveries"}
              onClick={() => setTab("deliveries")}
            >
              Callback deliveries{" "}
              <span>{snapshot.deliveries.deliveries.length}</span>
            </button>
          </div>
          <div hidden={tab !== "events"}>
            {snapshot.events.availability === "missing" && (
              <p className="notice">
                Stage log unavailable. It may not exist yet or may have expired
                under retention.
              </p>
            )}
            {snapshot.events.malformed > 0 && (
              <p className="notice">
                Skipped {snapshot.events.malformed} malformed records. This
                history is incomplete.
              </p>
            )}
            {snapshot.events.incompleteLine && (
              <p className="notice">
                A final log record is incomplete. It will be checked again on
                refresh.
              </p>
            )}
            <LogTable
              rows={snapshot.events.events}
              kind="events"
              more={!!snapshot.events.nextCursor}
              onMore={() => setEventPages((p) => p + 1)}
            />
            <p className="footnote">
              Stage activity is recorded history, not a worker heartbeat. A
              quiet interval does not prove a stalled worker.
            </p>
          </div>
          <div hidden={tab !== "deliveries"}>
            <div className="subscription-list">
              {snapshot.notification.subscriptions.map((s, i) => (
                <span key={i}>
                  <code>{s.name.replace("audiogram.job.", "")}</code>{" "}
                  <Badge value={s.state} />
                </span>
              ))}
            </div>
            {!snapshot.deliveries.available && (
              <p className="notice">
                This database has no event-delivery tables.
              </p>
            )}
            <LogTable
              rows={snapshot.deliveries.deliveries}
              kind="deliveries"
              more={!!snapshot.deliveries.nextCursor}
              onMore={() => setDeliveryPages((p) => p + 1)}
            />
            <p className="footnote">
              Attempt counts and current delivery results only. Historical
              attempt details are unavailable. Acknowledgement confirms callback
              receipt, not a message displayed in ChatGPT.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
export function App() {
  const initial = new URLSearchParams(window.location.search).get("job") ?? "";
  const [selected, setSelected] = useState(isJobId(initial) ? initial : ""),
    [input, setInput] = useState(initial),
    [inputError, setInputError] = useState(""),
    [pages, setPages] = useState(1);
  const recent = useRefresh<JobsPage>(String(pages), recentLoad, false);
  function choose(id: string) {
    setSelected(id);
    setInput(id);
    setInputError("");
    const url = new URL(window.location.href);
    url.searchParams.set("job", id);
    window.history.replaceState(null, "", url);
  }
  return (
    <main className="console-shell">
      <header className="console-header">
        <a className="brand" href="/">
          a<span>∙</span>
          <span className="brand-text">AUDIOGRAMS</span>
        </a>
        <span className="local-label">
          <span className="dot" />
          Local diagnostics · read only
        </span>
        <a className="back-link" href="/">
          Publishing queue ↗
        </a>
      </header>
      <div className="intro-heading">
        <div>
          <p className="eyebrow">Observe / Investigate</p>
          <h1>
            Every job. <span>One clear view.</span>
          </h1>
          <p>
            Follow the pipeline, inspect a failure, and trace callback delivery.
          </p>
        </div>
        <span className="source-label">
          Source: {recent.data?.source ?? "Local jobs"}
        </span>
      </div>
      <div className="workspace">
        <aside className="jobs-sidebar">
          <div className="sidebar-title">
            <h2>Recent jobs</h2>
            <button
              className="subtle"
              onClick={recent.refresh}
              aria-label="Refresh recent jobs"
            >
              ↻
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = input.trim();
              if (!isJobId(id)) {
                setInputError("Enter a valid Job ID.");
                return;
              }
              choose(id);
            }}
          >
            <label htmlFor="job-search">Jump to Job ID</label>
            <div className="job-search">
              <input
                id="job-search"
                placeholder="Paste a job ID"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit">Go</button>
            </div>
          </form>
          {inputError && (
            <p role="alert" className="inline-error">
              {inputError}
            </p>
          )}
          {recent.error && (
            <p role="alert" className="notice">
              {recent.error}.{" "}
              {recent.data
                ? "Showing the last successful list."
                : "Check the configured jobs database."}
            </p>
          )}
          <div className="jobs-list">
            {recent.data?.jobs.map((job) => (
              <button
                key={job.jobId}
                className={
                  "job-card " + (job.jobId === selected ? "selected" : "")
                }
                aria-pressed={job.jobId === selected}
                onClick={() => choose(job.jobId)}
              >
                <div>
                  <Badge value={job.status} />
                  <time>{dateText(job.createdAt)}</time>
                </div>
                <strong>{job.title ?? job.videoId ?? "Untitled job"}</strong>
                <code>{job.jobId}</code>
              </button>
            ))}
          </div>
          {recent.data?.jobs.length === 0 && (
            <p className="empty compact">No jobs recorded yet.</p>
          )}
          {!recent.data && !recent.error && (
            <p className="empty compact">Loading recent jobs…</p>
          )}
          {recent.data?.nextCursor && (
            <button
              className="load-jobs"
              onClick={() => setPages((p) => p + 1)}
            >
              Load 50 older jobs
            </button>
          )}
        </aside>
        {selected ? (
          <JobView key={selected} id={selected} />
        ) : (
          <section className="empty welcome">
            <span className="welcome-mark">↳</span>
            <h2>Choose a job to investigate</h2>
            <p>
              Select any recent run, or paste the Job ID returned by ChatGPT.
            </p>
            <div className="welcome-tags">
              <span>Stage history</span>
              <span>Clip failures</span>
              <span>Callback delivery</span>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
