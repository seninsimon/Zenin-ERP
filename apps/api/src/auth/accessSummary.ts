import { accessOf } from "../apps/access.js";
import { launcherApp } from "../apps/index.js";
import { listRoles } from "../repo/userRepo.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import type { CurrentUser, TableSchema } from "../types.js";
import { allowedDepartments, isAdmin, tablePermissions } from "./access.js";

// Plain answers for admins, worked out with the same rules the server
// enforces (access.ts), so they can't disagree with what people really see:
//   - "What they can do": every table, for one person;
//   - "Who can use this table": every role that opens one table.

type App = { key: string; name: string; icon: string } | null;
const appOf = (schema: TableSchema): App => {
  const a = launcherApp(schema.appKey);
  return a ? { key: a.key, name: a.name, icon: a.icon } : null;
};

export type TableAccess = {
  tableName: string;
  app: App;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  // sees only their own records
  own: boolean;
  // split by department: the departments whose records they see (null = every record)
  departments: string[] | null;
  // their role allows it, but the table is split by department and they're in
  // none of its departments: the names they'd need (empty = admins only)
  needsDepartment?: string[];
};

export async function personAccess(user: CurrentUser) {
  const base = {
    admin: isAdmin(user),
    role: user.role.name,
    // "Projects: manager" as chosen in App access
    appLevels: accessOf(user),
    departments: user.departments.map((d) => d.name),
  };
  if (base.admin) return { ...base, tables: [] as TableAccess[] };

  const tables: TableAccess[] = [];
  for (const schema of await getAllSchemas()) {
    const p = tablePermissions(user, schema);
    const row = { tableName: schema.tableName, app: appOf(schema), own: false, departments: null };
    if (p.view) {
      tables.push({
        ...row,
        view: true,
        create: p.create,
        edit: p.edit,
        delete: p.delete,
        own: Boolean(p.own),
        // own only: their own records, whichever department they're in
        departments: schema.byDepartment && !p.own ? allowedDepartments(user, schema).map((d) => d.name) : null,
      });
      continue;
    }
    const granted = user.role.permissions?.[schema.tableName];
    tables.push({
      ...row,
      view: false,
      create: false,
      edit: false,
      delete: false,
      ...(granted?.view && schema.byDepartment ? { needsDepartment: schema.departments.map((d) => d.name) } : {}),
    });
  }
  return { ...base, tables };
}

// Every role that opens this table (admins always do), with how many people have it.
export async function tableAccess(schema: TableSchema) {
  const roles = await listRoles();
  const admins = roles.filter((r) => r.isAdmin).reduce((n, r) => n + r.userCount, 0);
  const entries = roles
    .filter((r) => !r.isAdmin && r.permissions?.[schema.tableName]?.view)
    .map((r) => {
      const p = r.permissions[schema.tableName];
      return {
        roleId: r._id,
        // app roles are stored as "HR & leave · Manager"
        name: r.name,
        appKey: r.appKey,
        view: true,
        create: Boolean(p.create),
        edit: Boolean(p.edit),
        delete: Boolean(p.delete),
        own: Boolean(p.own),
        people: r.userCount,
      };
    })
    .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
  return {
    admins,
    splitByDepartment: schema.byDepartment,
    departments: schema.departments.map((d) => d.name),
    roles: entries,
  };
}
