import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  useTable,
  tableFeatures,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  filterFn_equalsString,
  sortFn_basic,
  type ColumnDef,
} from "@tanstack/react-table";
import type { LogRow } from "./api";

export function Badge({ value }: { value: string }) {
  return (
    <span className={"badge " + value.replace(/[^a-z_]/g, "")}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
export const dateText = (value: unknown) => {
  if (typeof value !== "string") return "—";
  const date = new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z",
  );
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
};
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: {
    includesString: filterFn_includesString,
    equalsString: filterFn_equalsString,
  },
  sortFns: { basic: sortFn_basic },
});
const sets = {
  events: [
    ["timestamp", "Time"],
    ["stage", "Stage"],
    ["clipPackageId", "Clip"],
    ["treatmentId", "Treatment"],
    ["status", "Status"],
    ["durationMs", "Duration"],
    ["errorCode", "Code"],
  ],
  deliveries: [
    ["timestamp", "Recorded"],
    ["name", "Event"],
    ["sequence", "Sequence"],
    ["status", "Delivery"],
    ["attempts", "Attempts"],
    ["lastCode", "Last retained error"],
    ["ackedAt", "Acknowledged"],
  ],
};
export function LogTable({
  rows,
  kind,
  more,
  onMore,
}: {
  rows: LogRow[];
  kind: "events" | "deliveries";
  more: boolean;
  onMore: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const columns = useMemo<ColumnDef<typeof features, LogRow>[]>(
    () =>
      sets[kind].map(([key, label]) => ({
        id: key,
        accessorFn: (row) => row[key] ?? "",
        header: label,
        sortFn: "basic",
        filterFn:
          key === "timestamp"
            ? (row, id, value: unknown) => {
                const [from, to] = value as [string, string];
                const time = Date.parse(String(row.getValue(id)));
                return (
                  (!from || time >= Date.parse(from)) &&
                  (!to || time <= Date.parse(to))
                );
              }
            : "equalsString",
        cell: (info) => {
          const value = info.getValue();
          if (key === "status") return <Badge value={String(value)} />;
          if (key === "timestamp" || key === "ackedAt") return dateText(value);
          if (key === "durationMs")
            return typeof value === "number"
              ? `${(value / 1000).toFixed(1)}s`
              : "—";
          return value === ""
            ? "—"
            : String(value).replace("audiogram.job.", "");
        },
      })),
    [kind],
  );
  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    globalFilterFn: "includesString",
  });
  const global = String(table.state.globalFilter ?? "");
  const dateRange = (table.getColumn("timestamp")?.getFilterValue() ?? [
    "",
    "",
  ]) as [string, string];
  useEffect(() => {
    if (follow && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [rows.length, follow]);
  return (
    <>
      <div className="filter-bar">
        <label className="search-label">
          Search loaded rows
          <input
            placeholder="Search stages, codes, treatments…"
            value={global}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
          />
        </label>
        {(kind === "events"
          ? ["stage", "clipPackageId", "status"]
          : ["status"]
        ).map((key) => (
          <label key={key}>
            {key === "clipPackageId"
              ? "Clip"
              : key === "stage"
                ? "Stage"
                : "Status"}
            <select
              value={String(table.getColumn(key)?.getFilterValue() ?? "")}
              onChange={(e) =>
                table
                  .getColumn(key)
                  ?.setFilterValue(e.target.value || undefined)
              }
            >
              <option value="">All</option>
              {[...new Set(rows.map((row) => String(row[key] ?? "")))]
                .filter(Boolean)
                .sort()
                .map((value) => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </label>
        ))}
        <label>
          From
          <input
            type="datetime-local"
            value={dateRange[0]}
            onChange={(e) =>
              table
                .getColumn("timestamp")
                ?.setFilterValue([e.target.value, dateRange[1]])
            }
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={dateRange[1]}
            onChange={(e) =>
              table
                .getColumn("timestamp")
                ?.setFilterValue([dateRange[0], e.target.value])
            }
          />
        </label>
        <button
          className="subtle"
          onClick={() => {
            table.resetColumnFilters();
            table.setGlobalFilter("");
          }}
        >
          Clear filters
        </button>
      </div>
      <div className="table-caption">
        <span>
          {table.getRowModel().rows.length} shown · {rows.length} loaded
          {more ? " · more available" : ""}. Filters apply to loaded rows.
        </span>
        <label className="toggle">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow new rows
        </label>
      </div>
      <div
        ref={scroll}
        className="table-scroll"
        tabIndex={0}
        aria-label={
          kind === "events"
            ? "Stage event history"
            : "Callback delivery records"
        }
      >
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th aria-label="Details" />
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <button onClick={() => header.column.toggleSorting()}>
                      <table.FlexRender header={header} />
                      <span className="sort-arrow">
                        {header.column.getIsSorted() === "asc"
                          ? "↑"
                          : header.column.getIsSorted() === "desc"
                            ? "↓"
                            : "↕"}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <Fragment key={row.id}>
                <tr>
                  <td>
                    <button
                      className="expand"
                      aria-label={"Details for " + row.id}
                      aria-expanded={expanded.has(row.id)}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })
                      }
                    >
                      {expanded.has(row.id) ? "−" : "+"}
                    </button>
                  </td>
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
                {expanded.has(row.id) && (
                  <tr className="detail-row">
                    <td colSpan={columns.length + 1}>
                      <pre>{JSON.stringify(row.original, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {table.getRowModel().rows.length === 0 && (
          <div className="empty compact">No rows match this view.</div>
        )}
      </div>
      {more && (
        <div className="load-more">
          <button onClick={onMore}>Load next 100 records</button>
        </div>
      )}
    </>
  );
}
