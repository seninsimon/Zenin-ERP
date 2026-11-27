import { ALL_RECORDS, isAdmin } from "../auth/access.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getRecord } from "../repo/recordRepo.js";
import type { ChoiceOption, Column, CurrentUser, RecordData, TableSchema } from "../types.js";
import { getSchema } from "./schemaRepo.js";

// Locked records (docs/WORKFLOW.md): a choice option can lock
// the record ("Approved", "Paid"). A locked record can't be changed or
// deleted by anyone, through any screen or the API, until a Manager of its
// app (or an admin) reopens it. Its line items are locked with it. What the
// server works out (formulas, totals from other records) still updates.

export type Lock = {
  column: Column;
  option: ChoiceOption;
  // set when it's the record's parent that's locked (a line of a paid invoice)
  parent?: { table: string; id: string };
};

// The option that locks this record, if any (a record's own values only).
export function ownLock(schema: TableSchema, data: RecordData): Lock | null {
  for (const column of schema.columns) {
    if (column.type !== "choice") continue;
    const chosen = Array.isArray(data[column.name]) ? (data[column.name] as unknown[]) : [data[column.name]];
    const option = column.options?.find((o) => o.locks && chosen.includes(o.label));
    if (option) return { column, option };
  }
  return null;
}

// Line items: locked when the record they belong to is.
async function parentLock(schema: TableSchema, data: RecordData, db?: Db): Promise<Lock | null> {
  for (const link of schema.columns) {
    if (link.type !== "relation" || !link.inline || !link.ref || typeof data[link.name] !== "string") continue;
    const parentSchema = await getSchema(link.ref);
    const parent = parentSchema && (await getRecord(link.ref, data[link.name] as string, ALL_RECORDS, db));
    const lock = parentSchema && parent ? ownLock(parentSchema, parent.data) : null;
    if (lock) return { ...lock, parent: { table: link.ref, id: parent!._id } };
  }
  return null;
}

// Is this record (or the record it's a line of) locked?
export async function lockOf(schema: TableSchema, data: RecordData, db?: Db): Promise<Lock | null> {
  return ownLock(schema, data) ?? (await parentLock(schema, data, db));
}

const said = (lock: Lock) => `${lock.column.label || lock.column.name} is ${lock.option.label}`;

export const lockedError = (lock: Lock) =>
  new HttpError(
    409,
    lock.parent
      ? `Locked: the record this belongs to is locked (${said(lock)}). A manager can reopen it.`
      : `Locked: ${said(lock)}. A manager can reopen it to make changes.`,
    { _locked: lock.option.label }
  );

// Refuse a change to a locked record, or a line added to / moved into one.
export async function assertNotLocked(schema: TableSchema, before: RecordData | null, values: RecordData, db?: Db) {
  const lock = (before && (await lockOf(schema, before, db))) ?? (await parentLock(schema, values, db));
  if (lock) throw lockedError(lock);
}

// Who may reopen: admins, and Managers of the table's app.
export function canReopen(user: CurrentUser, schema: TableSchema) {
  if (isAdmin(user)) return true;
  const app = schema.appKey ?? "my-tables";
  return user.appRoles.some((r) => r.appKey === app && r.appLevel === "manager");
}

// The statuses a reopened record can go back to (options that don't lock).
export const reopenTargets = (column: Column) => (column.options ?? []).filter((o) => !o.locks).map((o) => o.label);
