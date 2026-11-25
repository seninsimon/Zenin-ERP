import { randomBytes } from "node:crypto";
import type pg from "pg";
import { isUniqueViolation, query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getAllSchemas, getSchema, invalidateSchemas } from "../schema/schemaRepo.js";
import type { Permissions } from "../types.js";
import { APP_BY_KEY, launcherApp, MY_TABLES } from "./index.js";
import type { AppBlueprint } from "./types.js";

// Your own apps (workspace/ACCESS_PLAN.md part 3). Every table belongs to an
// app, and every app has a Manager and a Staff role, so access is always
// given the same way: App access on the person.
//   - "My tables" (key my-tables): tables you built yourself. A table with
//     no app_key is in it.
//   - Apps you make (key custom-…): a name and an icon. They're kept in
//     installed_apps like AI-drafted apps, so removing one works the same way:
//     tables it didn't create move to My tables, and its roles go.
// Managers of an app always have everything on its tables; what Staff may do
// is chosen when a table is added.

export { MY_TABLES };
const MY_TABLES_INFO = { name: "My tables", icon: "IconTable", description: "Tables you built yourself" };
const OWN_PREFIX = "custom-";
const MANAGER: Permissions = { view: true, create: true, edit: true, delete: true };

// What Staff may do in a table, chosen when it's added: nothing, look, or work in it.
export const STAFF_CHOICES = {
  none: null,
  view: { view: true, create: false, edit: false, delete: false },
  work: { view: true, create: true, edit: true, delete: false },
} as const satisfies Record<string, Permissions | null>;
export type StaffChoice = keyof typeof STAFF_CHOICES;
export const isStaffChoice = (v: unknown): v is StaffChoice => typeof v === "string" && v in STAFF_CHOICES;

type OwnOptions = { own?: { name: string; icon: string; description?: string }; name?: string; icon?: string };

export const isOwnApp = (key: string) => key === MY_TABLES || key.startsWith(OWN_PREFIX);

// The icons an app can have (all in the web's AppIcon set).
export const APP_ICONS = [
  "IconApps",
  "IconTable",
  "IconBriefcase",
  "IconShoppingCart",
  "IconTruck",
  "IconBuildingWarehouse",
  "IconPackage",
  "IconTool",
  "IconCash",
  "IconChartBar",
  "IconCalendar",
  "IconClipboardList",
  "IconUsers",
  "IconSchool",
  "IconStethoscope",
  "IconHeadset",
  "IconHome",
];

const cleanName = (v: unknown) => {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new HttpError(400, "Give the app a name");
  if (name.length > 40) throw new HttpError(400, "Keep the name under 40 characters");
  if (name.includes("·")) throw new HttpError(400, "The name can't contain ·");
  return name;
};
const cleanIcon = (v: unknown) => (typeof v === "string" && APP_ICONS.includes(v) ? v : "IconApps");

const blueprint = (key: string, info: { name: string; icon: string; description?: string }): AppBlueprint => ({
  key,
  version: 1,
  name: info.name,
  description: info.description ?? "",
  icon: info.icon,
  tables: [],
});

// Put own apps (and new names of drafted apps) in the registry. Called at
// start-up and before listing, like loadDraftedApps.
export async function loadOwnApps(db?: pg.PoolClient) {
  const { rows } = await query<{ key: string; options: OwnOptions }>(
    `SELECT key, options FROM installed_apps WHERE key = $1 OR key LIKE 'custom-%'`,
    [MY_TABLES],
    db
  );
  for (const { key, options } of rows) {
    const base = options?.own ? blueprint(key, options.own) : APP_BY_KEY.get(key);
    if (!base) continue;
    APP_BY_KEY.set(key, { ...base, name: options.name ?? base.name, icon: options.icon ?? base.icon });
  }
}

async function createLevelRoles(key: string, name: string, client: pg.PoolClient) {
  for (const [level, label, description] of [
    ["manager", "Manager", "Runs the team: everything in this app's tables"],
    ["staff", "Staff", "Everyday work in this app"],
  ] as const) {
    let roleName = `${name} · ${label}`;
    for (let n = 2; (await query(`SELECT 1 FROM roles WHERE lower(name) = lower($1)`, [roleName], client)).rowCount; n++) {
      roleName = `${name} (${n}) · ${label}`;
    }
    await query(
      `INSERT INTO roles (name, description, permissions, app_key, app_level) VALUES ($1, $2, '{}'::jsonb, $3, $4)
       ON CONFLICT (app_key, app_level) WHERE app_key IS NOT NULL DO NOTHING`,
      [roleName, description, key, level],
      client
    );
  }
}

// "My tables" exists, with its two roles, and its Manager has everything on
// every table in it. Safe to run any time (start-up, after removing an app).
export async function ensureMyTables() {
  await withTransaction(async (client) => {
    await query(
      `INSERT INTO installed_apps (key, version, options) VALUES ($1, 1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [MY_TABLES, JSON.stringify({ own: MY_TABLES_INFO })],
      client
    );
    await createLevelRoles(MY_TABLES, MY_TABLES_INFO.name, client);
    const { rows } = await query<{ table_name: string }>(`SELECT table_name FROM table_schemas WHERE app_key IS NULL`, [], client);
    const perms = Object.fromEntries(rows.map((r) => [r.table_name, MANAGER]));
    await query(`UPDATE roles SET permissions = permissions || $2::jsonb WHERE app_key = $1 AND app_level = 'manager'`, [MY_TABLES, JSON.stringify(perms)], client);
    await loadOwnApps(client);
  });
}

// "New app": a name and an icon, with its own Manager and Staff.
export async function createOwnApp(input: { name?: unknown; icon?: unknown }, userId: string) {
  const name = cleanName(input.name);
  const icon = cleanIcon(input.icon);
  const taken = [...APP_BY_KEY.values()].some((a) => a.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new HttpError(409, `There's already an app called ${name}`);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "app";
  const key = `${OWN_PREFIX}${slug}-${randomBytes(3).toString("hex")}`;
  await withTransaction(async (client) => {
    await query(`INSERT INTO installed_apps (key, version, installed_by, options) VALUES ($1, 1, $2, $3::jsonb)`, [key, userId, JSON.stringify({ own: { name, icon } })], client);
    await createLevelRoles(key, name, client);
  });
  APP_BY_KEY.set(key, blueprint(key, { name, icon }));
  return { key, name, icon };
}

// Rename an app you made (or My tables, or an AI-drafted app), and its roles.
export async function renameOwnApp(key: string, input: { name?: unknown; icon?: unknown }) {
  if (!isOwnApp(key) || !APP_BY_KEY.has(key)) throw new HttpError(404, "Only apps you made can be renamed");
  const name = cleanName(input.name);
  const icon = input.icon === undefined ? APP_BY_KEY.get(key)!.icon : cleanIcon(input.icon);
  const taken = [...APP_BY_KEY.values()].some((a) => a.key !== key && a.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new HttpError(409, `There's already an app called ${name}`);
  try {
    await withTransaction(async (client) => {
      await query(`UPDATE installed_apps SET options = options || $2::jsonb WHERE key = $1`, [key, JSON.stringify({ name, icon })], client);
      await query(
        `UPDATE roles SET name = $2 || ' · ' || initcap(app_level), updated_at = now() WHERE app_key = $1 AND app_level IN ('manager', 'staff')`,
        [key, name],
        client
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, `A role called "${name} · Manager" or "${name} · Staff" already exists. Choose another name.`);
    throw error;
  }
  APP_BY_KEY.set(key, { ...APP_BY_KEY.get(key)!, name, icon });
  await invalidateSchemas();
  return { key, name, icon };
}

// The apps a table can be added to or moved into: My tables, apps you made,
// and installed apps that show as themselves (not the shared "Company").
export async function tableHomes() {
  await loadOwnApps();
  const { rows } = await query<{ key: string }>(`SELECT key FROM installed_apps ORDER BY installed_at`);
  const homes = rows
    .map((r) => r.key)
    .filter((key) => APP_BY_KEY.has(key) && (isOwnApp(key) || launcherApp(key)?.key === key))
    .map((key) => {
      const app = APP_BY_KEY.get(key)!;
      return { key, name: app.name, icon: app.icon, own: isOwnApp(key) };
    });
  // My tables first
  return homes.sort((a, b) => (a.key === MY_TABLES ? -1 : b.key === MY_TABLES ? 1 : a.name.localeCompare(b.name)));
}

export async function requireHome(app: unknown) {
  const key = typeof app === "string" && app ? app : MY_TABLES;
  if (key === MY_TABLES) await ensureMyTables();
  const home = (await tableHomes()).find((h) => h.key === key);
  if (!home) throw new HttpError(400, "Choose an app for the table");
  return home;
}

// Its Manager gets everything on the table; its Staff what was chosen.
async function giveRights(appKey: string, tableName: string, staff: Permissions | null, client: pg.PoolClient) {
  await query(
    `UPDATE roles SET permissions = permissions || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE app_key = $1 AND app_level = 'manager'`,
    [appKey, tableName, JSON.stringify(MANAGER)],
    client
  );
  if (staff) {
    await query(
      `UPDATE roles SET permissions = permissions || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE app_key = $1 AND app_level = 'staff'`,
      [appKey, tableName, JSON.stringify(staff)],
      client
    );
  } else {
    await query(`UPDATE roles SET permissions = permissions - $2::text, updated_at = now() WHERE app_key = $1 AND app_level = 'staff'`, [appKey, tableName], client);
  }
}

// A new table goes into an app (My tables when none is given).
export async function placeNewTable(tableName: string, app: unknown, staff: unknown) {
  const home = await requireHome(app);
  const choice = staff === undefined ? "none" : staff;
  if (!isStaffChoice(choice)) throw new HttpError(400, "Choose what Staff can do: none, view or work");
  await withTransaction(async (client) => {
    await query(`UPDATE table_schemas SET app_key = $2 WHERE table_name = $1`, [tableName, home.key === MY_TABLES ? null : home.key], client);
    await giveRights(home.key, tableName, STAFF_CHOICES[choice], client);
  });
  await invalidateSchemas();
  return home;
}

// Move a table you made to another app. It takes its Staff rights with it;
// the new app's Manager gets everything. Tables that came with an app stay
// in it. Roles you made yourself keep their rights.
export async function moveTable(tableName: string, app: unknown) {
  const schema = await getSchema(tableName);
  if (!schema) throw new HttpError(404, "Table not found");
  if (schema.blueprintKey) {
    throw new HttpError(409, `This table came with ${launcherApp(schema.appKey)?.name ?? "an app"}, so it stays there`);
  }
  const from = schema.appKey ?? MY_TABLES;
  const home = await requireHome(app);
  if (home.key === from) return { home, moved: false };
  await withTransaction(async (client) => {
    const { rows } = await query<{ permissions: Record<string, Permissions> }>(
      `SELECT permissions FROM roles WHERE app_key = $1 AND app_level = 'staff'`,
      [from],
      client
    );
    const staff = rows[0]?.permissions?.[tableName] ?? null;
    await query(`UPDATE roles SET permissions = permissions - $2::text, updated_at = now() WHERE app_key = $1`, [from, tableName], client);
    await query(`UPDATE table_schemas SET app_key = $2 WHERE table_name = $1`, [tableName, home.key === MY_TABLES ? null : home.key], client);
    await giveRights(home.key, tableName, staff, client);
  });
  await invalidateSchemas();
  return { home, moved: true };
}

// How many tables each own app has (for Manage apps).
export async function ownAppTables() {
  const out = new Map<string, string[]>();
  for (const s of await getAllSchemas()) {
    const key = s.appKey ?? MY_TABLES;
    if (!isOwnApp(key)) continue;
    out.set(key, [...(out.get(key) ?? []), s.tableName]);
  }
  return out;
}
