import { visibleColumns } from "../auth/fields.js";
import type { Request, Response } from "express";
import { launcherApp } from "../apps/index.js";
import { allowedDepartments, can, isAdmin, tablePermissions } from "../auth/access.js";
import { ownFieldsFor } from "../auth/ownership.js";
import { HttpError, param, toIdList } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { assignUnassigned, countUnassigned } from "../repo/recordRepo.js";
import { existingDepartmentIds } from "../repo/userRepo.js";
import { FILE_COLUMN_TYPES } from "../schema/columns.js";
import {
  addColumn,
  createTable,
  deleteColumn,
  deleteTable,
  findRelationsTo,
  getAllSchemas,
  getSchema,
  updateColumn,
  updateTableSettings,
} from "../schema/schemaRepo.js";
import { tryFormula } from "../schema/formula.js";
import { changeBack, checkConversion, conversionOf, convertColumn } from "../schema/convert.js";
import { tableAccess } from "../auth/accessSummary.js";
import { isStaffChoice, moveTable, MY_TABLES, placeNewTable, requireHome } from "../apps/ownApps.js";
import { assertNotUsedByRollups } from "../schema/rollups.js";
import { deleteUploads } from "../storage.js";
import type { CurrentUser, TableSchema } from "../types.js";

// What the current user may do with a table, added to the schema, and the
// app it belongs to in the launcher and sidebar ("Company", "Projects"; null = your own).
const withAccess = (user: CurrentUser, schema: TableSchema) => ({
  ...schema,
  // fields hidden from this person aren't even described to them
  columns: visibleColumns(user, schema),
  app: launcherApp(schema.appKey),
  permissions: tablePermissions(user, schema),
  allowedDepartments: allowedDepartments(user, schema),
});

const requireTable = async (name: string) => {
  const schema = await getSchema(name);
  if (!schema) throw new HttpError(404, "Table not found");
  return schema;
};

// Admins get every table; other users only the ones they can view.
export async function getTables(req: Request, res: Response) {
  const user = currentUser(req);
  const schemas = await getAllSchemas();
  res.json(schemas.filter((s) => can(user, s, "view")).map((s) => withAccess(user, s)));
}

export async function getTableSchema(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await getSchema(param(req, "table"));
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, "Table not found");

  const result: Record<string, unknown> = withAccess(user, schema);
  if (isAdmin(user)) result.unassignedCount = await countUnassigned(schema.tableName);
  // "own only": the fields that make a record theirs, locked to them in the form
  const own = await ownFieldsFor(schema, user);
  if (own.length) result.ownFields = own;
  res.json(result);
}

/* ---------------- admin: tables ---------------- */

// POST /schema { tableName, columns?, app?, staff? }: a new table goes into an
// app (My tables when none is given). Its Manager gets everything; its Staff
// what was chosen: none (the default), view or work (view, add and edit).
export async function createTableHandler(req: Request, res: Response) {
  const { app, staff } = (req.body ?? {}) as { app?: unknown; staff?: unknown };
  if (staff !== undefined && !isStaffChoice(staff)) throw new HttpError(400, "Choose what Staff can do: none, view or work");
  await requireHome(app); // before anything is created
  const schema = await createTable(req.body ?? {});
  const home = await placeNewTable(schema.tableName, app, staff);
  await audit(req, { action: "create", entity: "table", tableName: schema.tableName, changes: { app: home.name, staff: staff ?? "none" } });
  res.json({ message: "Table created", data: { ...schema, appKey: home.key === MY_TABLES ? null : home.key } });
}

// PUT /schema/:table/app { app }: move a table you made to another app
export async function moveTableHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { home, moved } = await moveTable(tableName, req.body?.app);
  if (moved) await audit(req, { action: "settings", entity: "table", tableName, changes: { app: home.name } });
  res.json({ message: moved ? `Moved to ${home.name}` : "Already there", app: home });
}

export async function deleteTableHandler(req: Request, res: Response) {
  const schema = await requireTable(param(req, "table"));

  // totals elsewhere can't lose the records they add up
  await assertNotUsedByRollups(schema.tableName);
  // don't leave relation columns in other tables pointing at nothing
  const references = await findRelationsTo(schema.tableName);
  if (references.length) {
    const list = references.map((r) => `${r.tableName}.${r.column}`).join(", ");
    throw new HttpError(409, `Other tables link to "${schema.tableName}" (${list}). Delete those relation columns first.`);
  }

  const fileColumns = schema.columns.filter((c) => FILE_COLUMN_TYPES.includes(c.type)).map((c) => c.name);
  const fileUrls = await deleteTable(schema, fileColumns);
  await deleteUploads(fileUrls);
  await audit(req, { action: "delete", entity: "table", tableName: schema.tableName, changes: { deletedFiles: fileUrls.length } });

  res.json({ message: `Table "${schema.tableName}" deleted`, deletedFiles: fileUrls.length });
}

// PUT /schema/:table { showInMenu?, byDepartment?, departmentIds? }
export async function updateTableSettingsHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  let departmentIds: string[] | undefined;
  if (req.body?.departmentIds !== undefined) {
    departmentIds = toIdList(req.body.departmentIds);
    if ((await existingDepartmentIds(departmentIds)).length !== departmentIds.length) {
      throw new HttpError(400, "Unknown department selected");
    }
  }
  // "Split by department" with no department would hide the table from
  // everyone but admins without anyone meaning to: refuse it. (Only checked
  // when one of the two changes, so old tables can still be renamed etc.)
  if (req.body?.byDepartment !== undefined || departmentIds !== undefined) {
    const current = await requireTable(tableName);
    const split = typeof req.body?.byDepartment === "boolean" ? req.body.byDepartment : current.byDepartment;
    const count = departmentIds?.length ?? current.departments.length;
    if (split && count === 0) {
      throw new HttpError(400, "Choose at least one department, or let everyone with access see the records");
    }
  }
  const schema = await updateTableSettings(tableName, {
    showInMenu: req.body?.showInMenu,
    byDepartment: req.body?.byDepartment,
    spreadsheet: req.body?.spreadsheet,
    departmentIds,
  });
  await audit(req, {
    action: "settings",
    entity: "table",
    tableName,
    changes: {
      showInMenu: schema.showInMenu,
      recordsSeenBy: schema.byDepartment ? "each department" : "everyone with access",
      spreadsheet: schema.spreadsheet,
      departments: schema.departments.map((d) => d.name),
    },
  });

  // A table shared with one department never keeps "admins only" records:
  // e.g. records added before the table was shared become visible to it.
  // (With several departments the admin chooses, in the table's settings.)
  let moved = 0;
  if (schema.departments.length === 1) {
    const [only] = schema.departments;
    moved = await assignUnassigned(schema.tableName, only._id);
    if (moved) {
      await audit(req, {
        action: "assign_unassigned",
        entity: "table",
        tableName,
        changes: { department: only.name, records: moved },
      });
    }
  }
  res.json({ message: "Table settings updated", data: schema, moved });
}

// PUT /schema/:table/unassigned { departmentId }: records without a department go there
export async function assignUnassignedHandler(req: Request, res: Response) {
  const schema = await requireTable(param(req, "table"));
  const department = schema.departments.find((d) => d._id === req.body?.departmentId);
  if (!department) throw new HttpError(400, "Choose one of this table's departments");

  const updated = await assignUnassigned(schema.tableName, department._id);
  await audit(req, {
    action: "assign_unassigned",
    entity: "table",
    tableName: schema.tableName,
    changes: { department: department.name, records: updated },
  });
  res.json({ message: `${updated} record(s) assigned`, updated });
}

/* ---------------- admin: columns ---------------- */

export async function addColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { column } = await addColumn(tableName, req.body ?? {});
  await audit(req, { action: "create", entity: "column", tableName, recordId: column.name, changes: column });
  res.json({ message: "Column added", data: column });
}

export async function updateColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { before, after, rewritten } = await updateColumn(tableName, param(req, "name"), req.body ?? {});
  const changes: Record<string, unknown> = Object.fromEntries(
    (["label", "type", "showInTable", "required", "indexed", "default"] as const)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => [k, { from: before[k], to: after[k] }])
  );
  const labels = (c: typeof before) => (c.options ?? []).map((o) => o.label);
  if (JSON.stringify(labels(before)) !== JSON.stringify(labels(after))) {
    changes.options = { from: labels(before), to: labels(after) };
  }
  if (rewritten) changes.recordsUpdated = { to: rewritten };
  await audit(req, { action: "update", entity: "column", tableName, recordId: after.name, changes });
  // rewritten: records whose value was updated (renamed option, text -> choice)
  res.json({ message: "Column updated successfully", data: after, rewritten });
}

export async function deleteColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { removed } = await deleteColumn(tableName, param(req, "column"));
  await audit(req, { action: "delete", entity: "column", tableName, recordId: removed.name, changes: { type: removed.type } });
  res.json({ message: "Column removed" });
}

// POST /schema/:table/formula/check { expression, column? }: is the formula
// valid, what kind of value does it give, and what is it on the latest record?
export async function checkFormulaHandler(req: Request, res: Response) {
  const schema = await requireTable(param(req, "table"));
  const { expression, column } = (req.body ?? {}) as { expression?: unknown; column?: unknown };
  if (typeof expression !== "string" || !expression.trim()) throw new HttpError(400, "Enter a formula");
  res.json(await tryFormula(schema, expression, typeof column === "string" ? column : undefined));
}

// GET /schema/:table/access: every role that opens this table, for admins
export async function getTableAccessHandler(req: Request, res: Response) {
  res.json(await tableAccess(await requireTable(param(req, "table"))));
}

/* ---------------- make a typed field a formula (schema/convert.ts) ---------------- */

const expressionOf = (req: Request) => {
  const expression = (req.body ?? {}).expression;
  if (typeof expression !== "string" || !expression.trim()) throw new HttpError(400, "Enter a formula");
  if (expression.length > 1_000) throw new HttpError(400, "The formula is too long (max 1,000 characters)");
  return expression.trim();
};

// POST /schema/:table/column/:name/convert/check { expression }: how it fits
// today's records, and some it would change
export async function checkConvertHandler(req: Request, res: Response) {
  await requireTable(param(req, "table"));
  res.json(await checkConversion(param(req, "table"), param(req, "name"), { kind: "formula", expression: expressionOf(req) }));
}

// POST /schema/:table/column/:name/convert { expression }: make it a formula
export async function convertHandler(req: Request, res: Response) {
  const table = param(req, "table");
  await requireTable(table);
  const expression = expressionOf(req);
  const { before, after, changed } = await convertColumn(table, param(req, "name"), { kind: "formula", expression }, currentUser(req)._id);
  await audit(req, {
    action: "update",
    entity: "column",
    tableName: table,
    recordId: after.name,
    changes: { type: { from: before.type, to: "formula" }, formula: { to: expression }, recordsUpdated: { to: changed } },
  });
  res.json({ message: "It's a formula now", data: after, changed });
}

// GET /schema/:table/column/:name/convert: can it be changed back?
export async function conversionHandler(req: Request, res: Response) {
  await requireTable(param(req, "table"));
  res.json({ conversion: await conversionOf(param(req, "table"), param(req, "name")) });
}

// DELETE /schema/:table/column/:name/convert: Change back to a typed field
export async function changeBackHandler(req: Request, res: Response) {
  const table = param(req, "table");
  await requireTable(table);
  const { before, after, changed } = await changeBack(table, param(req, "name"));
  await audit(req, {
    action: "update",
    entity: "column",
    tableName: table,
    recordId: after.name,
    changes: { type: { from: before.type, to: after.type }, recordsUpdated: { to: changed } },
  });
  res.json({ message: "Changed back", data: after, changed });
}
