export type Job = {
  jobId: string;
  videoId: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  artifactCount: number;
  capture: string;
  summaryIncomplete: boolean;
  diagnosticsIncomplete: boolean;
  failures: { stage: string; code: string; packageId: string | null }[];
};
export type LogRow = {
  id: string;
  timestamp?: string;
  status?: string;
  stage?: string;
  clipPackageId?: number | string;
  [key: string]: unknown;
};
export type JobsPage = {
  source: string;
  jobs: Job[];
  nextCursor: string | null;
};
export type EventPage = {
  events: LogRow[];
  cursor: string | null;
  nextCursor: string | null;
  availability: string;
  malformed: number;
  incompleteLine: boolean;
  reset: boolean;
};
export type DeliveryPage = {
  deliveries: LogRow[];
  nextCursor: string | null;
  available: boolean;
  attemptHistoryAvailable: boolean;
};
export type Detail = {
  source: string;
  job: Job;
  notification: {
    available: boolean;
    delivery: string;
    subscriptions: { name: string; state: string; degraded: boolean }[];
  };
};
export type Snapshot = Detail & { events: EventPage; deliveries: DeliveryPage };
export async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Unable to read diagnostics",
    );
  return payload;
}
export async function loadJobs(
  pages: number,
  signal: AbortSignal,
): Promise<JobsPage> {
  let cursor: string | null = null;
  const jobs: Job[] = [];
  let source = "";
  for (let n = 0; n < pages; n++) {
    const result: JobsPage = await get(
      "/api/debug/jobs?limit=50" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      signal,
    );
    jobs.push(...result.jobs);
    source = result.source;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { jobs, source, nextCursor: cursor };
}
export async function loadSnapshot(
  key: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const [id, eventPages, deliveryPages] = JSON.parse(key) as [
    string,
    number,
    number,
  ];
  const base = "/api/debug/jobs/" + encodeURIComponent(id);
  const detail = await get<Detail>(base, signal);
  async function events() {
    let cursor: string | null = null,
      malformed = 0;
    const rows: LogRow[] = [];
    let last: EventPage;
    for (let n = 0; n < eventPages; n++) {
      last = await get<EventPage>(
        base +
          "/events?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        signal,
      );
      if (last.reset)
        throw new Error(
          "Stage log changed while reading. Retrying on the next refresh.",
        );
      rows.push(...last.events);
      malformed += last.malformed;
      cursor = last.nextCursor;
      if (!cursor) break;
    }
    return { ...last!, events: rows, malformed };
  }
  async function deliveries() {
    let cursor: string | null = null;
    const rows: LogRow[] = [];
    let last: DeliveryPage;
    for (let n = 0; n < deliveryPages; n++) {
      last = await get<DeliveryPage>(
        base +
          "/deliveries?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        signal,
      );
      rows.push(...last.deliveries);
      cursor = last.nextCursor;
      if (!cursor) break;
    }
    return { ...last!, deliveries: rows };
  }
  const [eventData, deliveryData] = await Promise.all([events(), deliveries()]);
  return { ...detail, events: eventData, deliveries: deliveryData };
}
