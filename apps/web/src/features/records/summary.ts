import api, { type ListFilter } from "../../api/api";
import type { Filter } from "../../components/data-table";
import { columnLabel, type RecordColumn } from "./schema";

// Helpers for the Summary view (SummaryView.tsx): what can be grouped and
// added up, and the list filter that shows one group's records.

// "Total Amount", "Average Amount"; a column already called "Total…" isn't doubled
export const measureLabel = (fn: string, label: string) =>
  fn === "count" ? "Records" : fn === "sum" ? (/^total\b/i.test(label) ? label : `Total ${label}`) : `Average ${label}`;

export type SummaryGroup = { key: string | null; label: string; count: number; value: number | null };

export const SUMMARY_GROUP_TYPES = ["choice", "user", "relation", "department", "boolean", "date"];
export const SUMMARY_NUMBER_TYPES = ["number", "formula", "rollup"];

// GET /table/:t/summary
export type Summary = {
  groupBy: { name: string; label: string; type: string };
  fn: "count" | "sum" | "avg";
  field: { name: string; label: string } | null;
  groups: SummaryGroup[];
  others: SummaryGroup | null;
  total: { count: number; value: number | null };
};

// "Sum of Amount", for a choice in the "Show" list
export const showOptions = (columns: RecordColumn[]) => [
  { value: "count", label: "Number of records" },
  ...columns
    .filter((c) => SUMMARY_NUMBER_TYPES.includes(c.type))
    .flatMap((c) => [
      { value: `sum:${c.name}`, label: measureLabel("sum", columnLabel(c)) },
      { value: `avg:${c.name}`, label: measureLabel("avg", columnLabel(c)) },
    ]),
];

const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

// The list filter that shows one group's records
export function groupFilter(column: RecordColumn, group: SummaryGroup): Filter {
  if (group.key === null) return { field: column.name, op: "isEmpty" };
  if (column.type === "boolean") return { field: column.name, op: group.key === "true" ? "isTrue" : "isFalse" };
  if (column.type === "date") return { field: column.name, op: "between", value: `${group.key}-01`, value2: lastDay(group.key) };
  return { field: column.name, op: "in", value: [group.key], labels: [group.label] };
}


/* ---- charts (reports part 2) ---- */

export type SummaryChartKind = "bar" | "line" | "donut";

// The charts that make sense: a line for months; a donut for the share of a
// choice or Yes/No (its own colours), not for averages; bars always.
export function chartKinds(column: RecordColumn, show: string): SummaryChartKind[] {
  if (column.type === "date") return ["line", "bar"];
  if ((column.type === "choice" || column.type === "boolean") && !column.multiple && !show.startsWith("avg:")) return ["bar", "donut"];
  return ["bar"];
}

// A group's colour in a donut: the choice option's own colour (as its badge)
export function groupColor(column: RecordColumn, group: SummaryGroup): string {
  if (group.key === null) return "gray.4";
  if (column.type === "boolean") return group.key === "true" ? "teal.6" : "gray.6";
  const color = column.options?.find((o) => o.label === group.key)?.color;
  return color ? `${color}.6` : "gray.5";
}

/* ---- fetching (the Summary view and the reports on Home share it) ---- */

export const summaryKey = (table: string, groupBy: string, show: string, search: string, filters: ListFilter[]) =>
  ["summary", table, groupBy, show, search, filters] as const;

export async function fetchSummary(table: string, groupBy: string, show: string, search: string, filters: ListFilter[]) {
  const [fn, field] = show.includes(":") ? show.split(":") : ["count", ""];
  const { data } = await api.get<Summary>(`/table/${encodeURIComponent(table)}/summary`, {
    params: { groupBy, fn, field: field || undefined, search: search || undefined, filters: filters.length ? JSON.stringify(filters) : undefined },
  });
  return data;
}

// The address of a table's Summary view with these choices
export function summaryPath(table: string, r: { groupBy: string; show: string; chart?: string | null; filters?: unknown[] }) {
  const q = new URLSearchParams({ view: "summary", group: r.groupBy });
  if (r.show !== "count") q.set("show", r.show);
  if (r.chart) q.set("chart", r.chart);
  if (r.filters?.length) q.set("f", JSON.stringify(r.filters));
  return `/table/${encodeURIComponent(table)}?${q}`;
}
