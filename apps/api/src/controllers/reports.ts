import type { Request, Response } from "express";
import { can, isAdmin } from "../auth/access.js";
import { hiddenColumns } from "../auth/fields.js";
import { launcherApp } from "../apps/index.js";
import { query } from "../db/pool.js";
import { cleanText, HttpError, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { parseFilters } from "../schema/filters.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { CurrentUser, TableSchema } from "../types.js";
import { GROUP_TYPES, NUMBER_TYPES } from "./summary.js";

// Reports (docs/WORKFLOW.md): a saved summary, shown in its
// app's block on Home and on the app's page. Admins pin them from the Summary
// view; apps bring a ready-made one. Everyone who can see the table sees the
// report, counting only the records they may see (the numbers come from
// GET /table/:t/summary, with the person's own permissions).

const CHARTS = ["bar", "line", "donut"];

type ReportRow = {
  _id: string;
  name: string;
  table_name: string;
  group_by: string;
  show: string;
  chart: string | null;
  filters: unknown[];
  created_at: Date;
};

export type ReportOut = {
  id: string;
  name: string;
  table: string;
  groupBy: string;
  show: string;
  chart: string | null;
  filters: unknown[];
  // admins only: why it can't be shown any more (a column was removed)
  problem?: string;
};

// What makes a report valid for a table; the problem in words, or null.
function problemOf(schema: TableSchema, r: { groupBy: string; show: string; filters: unknown[] }, hidden: Set<string>): string | null {
  const group = schema.columns.find((c) => c.name === r.groupBy);
  if (!group || !GROUP_TYPES.includes(group.type)) return "The column it groups by was removed or changed";
  if (hidden.has(group.name)) return "hidden";
  if (r.show !== "count") {
    const [fn, name] = r.show.split(":");
    const field = schema.columns.find((c) => c.name === name);
    if (!["sum", "avg"].includes(fn) || !field || !NUMBER_TYPES.includes(field.type)) return "The number column it adds up was removed or changed";
    if (hidden.has(field.name)) return "hidden";
  }
  try {
    const filters = parseFilters(r.filters, schema);
    if (filters.some((f) => hidden.has(f.field))) return "hidden";
  } catch {
    return "One of its filters no longer fits the table";
  }
  return null;
}

// The reports this person sees, with the launcher (app) each belongs to.
export async function reportsFor(user: CurrentUser): Promise<(ReportOut & { launcher: { key: string; name: string; icon: string } })[]> {
  const { rows } = await query<ReportRow>(`SELECT * FROM reports ORDER BY created_at, _id`);
  const out = [];
  for (const row of rows) {
    const schema = await getSchema(row.table_name);
    if (!schema || !can(user, schema, "view")) continue;
    const report = { groupBy: row.group_by, show: row.show, filters: row.filters ?? [] };
    const problem = problemOf(schema, report, hiddenColumns(user, schema));
    if (problem === "hidden") continue; // uses a field this person can't see
    if (problem && !isAdmin(user)) continue;
    const launcher = launcherApp(schema.appKey) ?? { key: schema.appKey ?? "my-tables", name: "My tables", icon: "IconTable" };
    out.push({
      id: row._id,
      name: row.name,
      table: row.table_name,
      ...report,
      chart: row.chart,
      ...(problem ? { problem } : {}),
      launcher: { key: launcher.key, name: launcher.name, icon: launcher.icon },
    });
  }
  return out;
}

const readName = (raw: unknown) => {
  const name = cleanText(raw, 80);
  if (!name) throw new HttpError(400, "Give the report a name", { name: "Needed" });
  return name;
};

// POST /reports { name, table, groupBy, show, chart, filters } (admins)
export async function createReportHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const name = readName(body.name);
  const schema = typeof body.table === "string" ? await getSchema(body.table) : null;
  if (!schema) throw new HttpError(400, "Choose a table");
  const report = {
    groupBy: String(body.groupBy ?? ""),
    show: typeof body.show === "string" && body.show ? body.show : "count",
    filters: Array.isArray(body.filters) ? body.filters : [],
  };
  const problem = problemOf(schema, report, new Set());
  if (problem) throw new HttpError(400, problem === "hidden" ? "It uses a hidden field" : problem);
  const chart = CHARTS.includes(body.chart) ? body.chart : null;
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO reports (name, table_name, group_by, show, chart, filters, created_by) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING _id`,
    [name, schema.tableName, report.groupBy, report.show, chart, JSON.stringify(parseFilters(report.filters, schema)), currentUser(req)._id]
  );
  await audit(req, { action: "create", entity: "report", recordId: rows[0]._id, tableName: schema.tableName, changes: { name: { to: name } } });
  res.status(201).json({ message: "Pinned to Home", id: rows[0]._id });
}

// PUT /reports/:id { name } (admins)
export async function renameReportHandler(req: Request, res: Response) {
  const name = readName(req.body?.name);
  const { rows } = await query<{ name: string }>(`SELECT name FROM reports WHERE _id = $1`, [param(req, "id")]);
  if (!rows[0]) throw new HttpError(404, "Report not found");
  await query(`UPDATE reports SET name = $2 WHERE _id = $1`, [param(req, "id"), name]);
  await audit(req, { action: "update", entity: "report", recordId: param(req, "id"), changes: { name: { from: rows[0].name, to: name } } });
  res.json({ message: "Renamed" });
}

// DELETE /reports/:id (admins): off Home (the table and its records stay)
export async function deleteReportHandler(req: Request, res: Response) {
  const { rows } = await query<{ name: string }>(`DELETE FROM reports WHERE _id = $1 RETURNING name`, [param(req, "id")]);
  if (!rows[0]) throw new HttpError(404, "Report not found");
  await audit(req, { action: "delete", entity: "report", recordId: param(req, "id"), changes: { name: { from: rows[0].name } } });
  res.json({ message: "Removed from Home" });
}
