import type { Request, Response } from "express";
import { ALL_RECORDS, can, recordScope } from "../auth/access.js";
import { assertCanUse, hiddenColumns } from "../auth/fields.js";
import { ownLinkIds } from "../auth/ownership.js";
import { dataTable } from "../db/dataTables.js";
import { isMissingTable, query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { getRecordsByIds, recordConditions } from "../repo/recordRepo.js";
import { departmentNames, getUserOptionsByIds, userLabel } from "../repo/userRepo.js";
import { pickDisplayField } from "../schema/columns.js";
import { parseFilters } from "../schema/filters.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { Column, CurrentUser, TableSchema } from "../types.js";
import { loadTable } from "./records.js";

// Summary on any list (docs/WORKFLOW.md): the records of a
// table grouped by one column, with the count and, for a number column, its
// sum or average. Same search, filters and permissions as the list: each
// person counts only the records they may see; hidden fields can't be used.
// Worked out in the database.

export const GROUP_TYPES = ["choice", "user", "relation", "department", "boolean", "date"];
// columns whose stored value can be a number
export const NUMBER_TYPES = ["number", "formula", "rollup"];
const MAX_GROUPS = 100; // the rest are added up as "Others"
const SCAN_GROUPS = 2000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Fn = "count" | "sum" | "avg";
type Group = { key: string | null; label: string; count: number; value: number | null };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// GET /table/:collection/summary?groupBy=status&fn=sum&field=amount&search=&filters=
export async function summaryHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");
  res.json(await summarize(user, schema, req.query));
}

export type SummaryQuery = { groupBy?: unknown; fn?: unknown; field?: unknown; search?: unknown; filters?: unknown };

// The summary itself, as this person may see it (also used by Ask Zenin's
// private mode, which works the numbers out here instead of in the AI)
export async function summarize(user: CurrentUser, schema: TableSchema, q: SummaryQuery) {
  const groupBy = schema.columns.find((c) => c.name === q.groupBy);
  if (!groupBy || !GROUP_TYPES.includes(groupBy.type)) throw new HttpError(400, "Choose a column to group by: a choice, person, department, link, Yes/No or date");
  const fn: Fn = q.fn === "sum" || q.fn === "avg" ? q.fn : "count";
  const field = fn === "count" ? null : schema.columns.find((c) => c.name === q.field);
  if (fn !== "count" && (!field || !NUMBER_TYPES.includes(field.type))) throw new HttpError(400, "Choose a number column to add up");
  const filters = parseFilters(q.filters, schema, user);
  // a hidden field can't be grouped, added up or filtered by (that would reveal it)
  const hidden = hiddenColumns(user, schema);
  for (const c of [groupBy, field]) if (c && hidden.has(c.name)) throw new HttpError(400, `You can't group or add up "${c.label || c.name}"`);
  assertCanUse(user, schema, filters.map((f) => f.field));

  const params: unknown[] = [];
  const where = recordConditions(
    schema,
    {
      scope: recordScope(user, schema),
      search: typeof q.search === "string" ? q.search.slice(0, 200) : "",
      filters,
      hide: [...hiddenColumns(user, schema)],
    },
    params
  );
  const table = dataTable(schema.tableName);
  const col = (c: Column) => `t.data -> ${quoteLiteral(c.name)}`;
  // a number only when it is one (formulas can give text)
  const amountText = field ? `CASE WHEN jsonb_typeof(${col(field)}) = 'number' THEN (t.data ->> ${quoteLiteral(field.name)})::numeric END` : "NULL::numeric";

  // the group of each record; several values (a multi-choice) put it in each
  const many = groupBy.multiple && groupBy.type !== "boolean" && groupBy.type !== "date";
  const join = many
    ? `LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(${col(groupBy)}) = 'array' THEN ${col(groupBy)} ELSE '[]'::jsonb END) k(v) ON TRUE`
    : "";
  const key = many
    ? "k.v"
    : groupBy.type === "date"
      ? `NULLIF(left(t.data ->> ${quoteLiteral(groupBy.name)}, 7), '')`
      : `NULLIF(t.data ->> ${quoteLiteral(groupBy.name)}, '')`;

  let rows: { key: string | null; count: number; sum: string | null; n: number }[] = [];
  let total = { count: 0, sum: null as string | null, n: 0 };
  try {
    rows = (
      await query<{ key: string | null; count: number; sum: string | null; n: number }>(
        `SELECT ${key} AS key, count(*)::int AS count, sum(${amountText}) AS sum, count(${amountText})::int AS n
         FROM ${table} t ${join}
         WHERE ${where}
         GROUP BY 1 ORDER BY 2 DESC LIMIT ${SCAN_GROUPS}`,
        params
      )
    ).rows;
    total = (
      await query<{ count: number; sum: string | null; n: number }>(
        `SELECT count(*)::int AS count, sum(${amountText}) AS sum, count(${amountText})::int AS n FROM ${table} t WHERE ${where}`,
        params
      )
    ).rows[0];
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  const valueOf = (count: number, sum: number | null, n: number): number | null =>
    fn === "count" ? count : fn === "sum" ? round(sum ?? 0) : n ? round((sum ?? 0) / n) : null;
  const labels = await labelsFor(user, schema, groupBy, rows.map((r) => r.key).filter((k): k is string => k !== null));

  let groups: (Group & { sum: number | null; n: number })[] = rows.map((r) => ({
    key: r.key,
    label: r.key === null ? "Not set" : (labels.get(r.key) ?? r.key),
    count: r.count,
    sum: num(r.sum),
    n: r.n,
    value: valueOf(r.count, num(r.sum), r.n),
  }));

  // the order people expect: a choice's own order, dates oldest first, else biggest first
  const empty = (g: Group) => (g.key === null ? 1 : 0);
  if (groupBy.type === "choice") {
    const order = new Map((groupBy.options ?? []).map((o, i) => [o.label, i]));
    groups.sort((a, b) => empty(a) - empty(b) || (order.get(a.key ?? "") ?? 999) - (order.get(b.key ?? "") ?? 999) || b.count - a.count);
  } else if (groupBy.type === "date") {
    groups.sort((a, b) => empty(a) - empty(b) || String(a.key).localeCompare(String(b.key)));
  } else if (groupBy.type === "boolean") {
    groups.sort((a, b) => empty(a) - empty(b) || (a.key === "true" ? -1 : 1));
  } else {
    groups.sort((a, b) => empty(a) - empty(b) || (b.value ?? 0) - (a.value ?? 0) || b.count - a.count);
  }

  // too many groups: the biggest stay, the rest are "Others"
  let others: Group | null = null;
  if (groups.length > MAX_GROUPS) {
    const byCount = [...groups].sort((a, b) => b.count - a.count);
    const keep = new Set(byCount.slice(0, MAX_GROUPS));
    const rest = groups.filter((g) => !keep.has(g));
    groups = groups.filter((g) => keep.has(g));
    const count = rest.reduce((s, g) => s + g.count, 0);
    const sum = rest.reduce((s, g) => s + (g.sum ?? 0), 0);
    const n = rest.reduce((s, g) => s + g.n, 0);
    others = { key: null, label: `${rest.length} others`, count, value: valueOf(count, sum, n) };
  }

  return {
    groupBy: { name: groupBy.name, label: groupBy.label || groupBy.name, type: groupBy.type },
    fn,
    field: field ? { name: field.name, label: field.label || field.name } : null,
    groups: groups.map(({ key, label, count, value }) => ({ key, label, count, value })),
    others,
    total: { count: total.count, value: valueOf(total.count, num(total.sum), total.n) },
  };
}

// Names for the group keys: people, departments, linked records (only ones
// this person may see), months, Yes/No. Choices are their own labels.
async function labelsFor(user: CurrentUser, schema: TableSchema, column: Column, keys: string[]): Promise<Map<string, string>> {
  switch (column.type) {
    case "user": {
      const people = await getUserOptionsByIds(keys);
      return new Map(keys.map((k) => [k, userLabel(people, k)]));
    }
    case "department": {
      const names = await departmentNames();
      return new Map(keys.map((k) => [k, names.get(k) ?? "Deleted department"]));
    }
    case "boolean":
      return new Map([["true", "Yes"], ["false", "No"]]);
    case "date":
      return new Map(
        keys.map((k) => {
          const [y, m] = k.split("-");
          return [k, MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : k];
        })
      );
    case "relation": {
      const ref = column.ref ? await getSchema(column.ref) : null;
      if (!ref) return new Map();
      // without access to the linked table, only your own entry is named
      const own = can(user, ref, "view") ? null : await ownLinkIds(schema, column.name, user);
      const display = pickDisplayField(ref, column.displayField);
      const wanted = own ? keys.filter((k) => own.has(k)) : keys;
      const found = wanted.length ? await getRecordsByIds(ref.tableName, wanted, own ? ALL_RECORDS : recordScope(user, ref)) : [];
      const names = new Map(found.map((r) => [r._id, String((display === "_id" ? r._id : r.data[display]) || r._id)]));
      return new Map(keys.map((k) => [k, names.get(k) ?? "Hidden record"]));
    }
    default:
      return new Map();
  }
}
