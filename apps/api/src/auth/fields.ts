import { launcherApp } from "../apps/index.js";
import { HttpError } from "../lib/http.js";
import { formulaRefs } from "../schema/formula.js";
import { peekSchema } from "../schema/schemaRepo.js";
import type { CurrentUser, TableSchema } from "../types.js";
import { isAdmin } from "./access.js";

// Fields some levels don't see (workspace/ACCESS_PLAN.md part 6). A column
// with onlyLevels ("manager") is seen and changed only by people with one of
// those levels in the table's app, and admins. This file decides it; every
// place that shows or takes values asks here:
//   - hiddenColumns(): the fields hidden from a person in a table, including
//     formulas that use a hidden field and totals over hidden fields of
//     another table, so nothing shows a value worked out from one;
//   - withoutHidden(): a record's values with those left out;
//   - assertCanWrite(): refuses values for hidden fields.

const appOf = (appKey: string | null) => launcherApp(appKey)?.key ?? appKey ?? "my-tables";

// the levels a person has in the table's app ("staff", "manager", …)
const levelsIn = (user: CurrentUser, schema: TableSchema) => {
  const app = appOf(schema.appKey);
  return new Set(user.appRoles.filter((r) => appOf(r.appKey) === app).map((r) => r.appLevel));
};

export function hiddenColumns(user: CurrentUser, schema: TableSchema, depth = 0): Set<string> {
  const hidden = new Set<string>();
  if (isAdmin(user)) return hidden;
  const mine = levelsIn(user, schema);
  for (const c of schema.columns) {
    if (c.onlyLevels?.length && !c.onlyLevels.some((l) => mine.has(l))) hidden.add(c.name);
  }
  // values worked out from hidden ones are hidden too (repeat: formulas of formulas)
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of schema.columns) {
      if (hidden.has(c.name)) continue;
      let hide = false;
      if (c.type === "formula") hide = formulaRefs(c).some((r) => hidden.has(r));
      if (c.type === "rollup" && c.rollup && depth < 5) {
        const child = peekSchema(c.rollup.from);
        if (child) {
          const h = hiddenColumns(user, child, depth + 1);
          hide = Boolean((c.rollup.field && h.has(c.rollup.field)) || (c.rollup.where && h.has(c.rollup.where.column)));
        }
      }
      if (hide) {
        hidden.add(c.name);
        grew = true;
      }
    }
  }
  return hidden;
}

// Fields limited for anyone who isn't an admin (and values worked out from
// them): left out of what goes to many people at once (notification titles,
// emails, reminders), where there's no one person to decide by.
const NOBODY = { _id: "", role: { isAdmin: false }, appRoles: [] } as unknown as CurrentUser;
export const limitedColumns = (schema: TableSchema) => hiddenColumns(NOBODY, schema);

export const visibleColumns = (user: CurrentUser, schema: TableSchema) => {
  const hidden = hiddenColumns(user, schema);
  return hidden.size ? schema.columns.filter((c) => !hidden.has(c.name)) : schema.columns;
};

// a record's values without the hidden fields
export function withoutHidden<T extends Record<string, unknown>>(data: T, hidden: Set<string>): T {
  if (!hidden.size || !data) return data;
  return Object.fromEntries(Object.entries(data).filter(([k]) => !hidden.has(k))) as T;
}

// refuses a value for a field the person can't see
export function assertCanWrite(user: CurrentUser, schema: TableSchema, values: Record<string, unknown> | null | undefined) {
  if (!values) return;
  const hidden = hiddenColumns(user, schema);
  const field = Object.keys(values).find((k) => hidden.has(k));
  if (field) {
    const c = schema.columns.find((x) => x.name === field);
    throw new HttpError(403, `You can't change "${c?.label || field}"`);
  }
}

// refuses filtering or sorting by a field the person can't see
export function assertCanUse(user: CurrentUser, schema: TableSchema, fields: (string | null | undefined)[]) {
  const hidden = hiddenColumns(user, schema);
  const field = fields.find((f) => f && hidden.has(f));
  if (field) {
    const c = schema.columns.find((x) => x.name === field);
    throw new HttpError(400, `You can't filter or sort by "${c?.label || field}"`);
  }
}
