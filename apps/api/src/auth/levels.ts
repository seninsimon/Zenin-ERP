import type pg from "pg";
import { loadDraftedApps } from "../apps/draft.js";
import { APP_BY_KEY, launcherApp, MY_TABLES } from "../apps/index.js";
import { defaultRolePerms } from "../apps/installer.js";
import { ensureMyTables } from "../apps/ownApps.js";
import { forgetAiSettings } from "../ai/settings.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getAllSchemas, invalidateSchemas } from "../schema/schemaRepo.js";
import type { PermissionMap, Permissions, TableSchema } from "../types.js";
import { normalizePermissions } from "./access.js";
import { mergePermissions } from "./mergePermissions.js";

// Access levels (docs/WORKFLOW.md). A level is what a person
// can do in one app: Staff, Manager, or one you add ("Accountant"). People get
// one level per app through App access. Under the hood a level is the app's
// role of that level (roles.app_key + app_level); an app shown as one in the
// launcher (Company = People + Customers + Products) has one role per part.
//
// "Older roles" (roles of no app, other than Admin and Member) come from
// before levels. moveOlderRoles() turns them into levels, exactly: it checks
// every person's rights before and after, and changes nothing if any differ.

const BUILT_IN: Record<string, string> = { staff: "Staff", manager: "Manager" };

type RoleRow = {
  _id: string;
  name: string;
  is_admin: boolean;
  permissions: PermissionMap;
  app_key: string | null;
  app_level: string | null;
};

const tableApp = (s: Pick<TableSchema, "appKey">) => s.appKey ?? MY_TABLES;
// the launcher entry an app is shown as ("company" for People, Customers, Products)
const launcherOf = (appKey: string) => launcherApp(appKey === MY_TABLES ? null : appKey)?.key ?? appKey;
const levelLabel = (role: Pick<RoleRow, "name" | "app_level">) =>
  BUILT_IN[role.app_level ?? ""] ?? (role.name.includes(" · ") ? role.name.split(" · ").slice(1).join(" · ") : (role.app_level ?? role.name));
const slugify = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "level";
// "purchase_orders" -> "Purchase orders", for level names
const readable = (table: string) => {
  const t = table.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const isOlder = (r: RoleRow, memberId: string | null) => !r.is_admin && !r.app_key && r._id !== memberId;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
// the rights on these tables, written one way ({ own: false } and no "own" mean the same)
const only = (perms: PermissionMap, tables: Set<string>): PermissionMap =>
  Object.fromEntries(
    Object.entries(perms ?? {})
      .filter(([t, p]) => tables.has(t) && p?.view)
      .map(([t, p]) => [t, { view: true, create: Boolean(p.create), edit: Boolean(p.edit), delete: Boolean(p.delete), ...(p.own ? { own: true } : {}) }])
  );

async function loadRoles(db?: pg.PoolClient) {
  return (await query<RoleRow>(`SELECT _id, name, is_admin, permissions, app_key, app_level FROM roles`, [], db)).rows;
}
async function memberRoleId(db?: pg.PoolClient) {
  const { rows } = await query<{ _id: string }>(`SELECT _id FROM roles WHERE lower(name) = 'member' AND app_key IS NULL AND NOT is_admin LIMIT 1`, [], db);
  return rows[0]?._id ?? null;
}
// every (person, role) pair: the main role and the extra ones
async function holdings(db?: pg.PoolClient) {
  const { rows } = await query<{ user_id: string; role_id: string; main: boolean }>(
    `SELECT _id AS user_id, role_id, true AS main FROM users
     UNION SELECT user_id, role_id, false FROM user_roles`,
    [],
    db
  );
  return rows;
}

/* ------------------------------------------------------------------ */
/* the apps, their tables and levels                                   */
/* ------------------------------------------------------------------ */

type Launcher = { key: string; name: string; icon: string; parts: Set<string>; tables: { tableName: string; appKey: string }[] };

async function launchers(db?: pg.PoolClient): Promise<Map<string, Launcher>> {
  const out = new Map<string, Launcher>();
  const add = (appKey: string) => {
    const key = launcherOf(appKey);
    const info = launcherApp(appKey === MY_TABLES ? null : appKey) ?? { key, name: APP_BY_KEY.get(appKey)?.name ?? appKey, icon: "IconApps" };
    const l = out.get(key) ?? { key, name: info.name, icon: info.icon, parts: new Set<string>(), tables: [] };
    l.parts.add(appKey);
    out.set(key, l);
    return l;
  };
  const { rows } = await query<{ key: string }>(`SELECT key FROM installed_apps`, [], db);
  for (const r of rows) if (APP_BY_KEY.has(r.key)) add(r.key);
  for (const s of await getAllSchemas()) add(tableApp(s)).tables.push({ tableName: s.tableName, appKey: tableApp(s) });
  return out;
}

export type LevelInfo = {
  level: string;
  name: string;
  custom: boolean;
  people: number;
  // what the level may do in each of the app's tables
  permissions: PermissionMap;
};

// Settings → Access levels: every app with its tables and levels, the
// older roles still to move, and how many admins there are.
export async function listLevels() {
  await loadDraftedApps();
  await ensureMyTables();
  const [apps, roles, held, memberId] = [await launchers(), await loadRoles(), await holdings(), await memberRoleId()];
  const holders = new Map<string, Set<string>>();
  for (const h of held) holders.set(h.role_id, (holders.get(h.role_id) ?? new Set()).add(h.user_id));

  const list = [...apps.values()].map((app) => {
    const tables = new Set(app.tables.map((t) => t.tableName));
    const byLevel = new Map<string, LevelInfo & { people_: Set<string> }>();
    for (const r of roles.filter((r) => r.app_key && app.parts.has(r.app_key))) {
      const level = r.app_level!;
      const entry = byLevel.get(level) ?? { level, name: levelLabel(r), custom: !BUILT_IN[level], people: 0, permissions: {}, people_: new Set<string>() };
      Object.assign(entry.permissions, only(r.permissions, tables));
      for (const u of holders.get(r._id) ?? []) entry.people_.add(u);
      byLevel.set(level, entry);
    }
    const levels = [...byLevel.values()]
      .map(({ people_, ...l }) => ({ ...l, people: people_.size }))
      .sort((a, b) => (BUILT_IN[a.level] ? (a.level === "staff" ? 0 : 1) : 2) - (BUILT_IN[b.level] ? (b.level === "staff" ? 0 : 1) : 2) || a.name.localeCompare(b.name));
    const catalog = [...app.parts].some((k) => APP_BY_KEY.get(k)?.roles?.length);
    const note = [...app.parts].map((k) => APP_BY_KEY.get(k)?.managerNote).find(Boolean) ?? null;
    return { key: app.key, name: app.name, icon: app.icon, tables: app.tables.map((t) => t.tableName).sort(), levels, resettable: catalog, managerNote: note };
  });
  list.sort((a, b) => {
    const rank = (k: string) => (k === "company" ? 0 : k === MY_TABLES ? 2 : 1);
    return rank(a.key) - rank(b.key) || a.name.localeCompare(b.name);
  });
  const olderRoles = roles
    .filter((r) => isOlder(r, memberId))
    .map((r) => ({ _id: r._id, name: r.name, people: holders.get(r._id)?.size ?? 0, tables: Object.keys(only(r.permissions, new Set(list.flatMap((a) => a.tables)))) }));
  const admins = new Set(held.filter((h) => roles.find((r) => r._id === h.role_id)?.is_admin).map((h) => h.user_id)).size;
  return { apps: list, olderRoles, admins };
}

async function requireApp(key: string, db?: pg.PoolClient) {
  await loadDraftedApps();
  const app = (await launchers(db)).get(key);
  if (!app) throw new HttpError(404, "App not found");
  return app;
}
const partName = (appKey: string) => (appKey === MY_TABLES ? APP_BY_KEY.get(MY_TABLES)?.name ?? "My tables" : APP_BY_KEY.get(appKey)?.name ?? appKey);

async function uniqueRoleName(base: string, client: pg.PoolClient) {
  let name = base;
  for (let n = 2; (await query(`SELECT 1 FROM roles WHERE lower(name) = lower($1)`, [name], client)).rowCount; n++) name = `${base} (${n})`;
  return name;
}

async function createLevelRole(appKey: string, level: string, label: string, perms: PermissionMap, client: pg.PoolClient) {
  const name = await uniqueRoleName(`${partName(appKey)} · ${label}`, client);
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO roles (name, description, permissions, app_key, app_level) VALUES ($1, '', $2::jsonb, $3, $4) RETURNING _id`,
    [name, JSON.stringify(perms), appKey, level],
    client
  );
  return rows[0]._id;
}

// What one level may do in each table of the app (replaces what it had).
export async function saveLevel(appKey: string, level: string, permissions: unknown) {
  const app = await requireApp(appKey);
  const perms = normalizePermissions(permissions);
  const tables = new Map(app.tables.map((t) => [t.tableName, t.appKey]));
  const outside = Object.keys(perms).find((t) => !tables.has(t));
  if (outside) throw new HttpError(400, `"${outside}" isn't in ${app.name}`);
  await withTransaction(async (client) => {
    const roles = (await loadRoles(client)).filter((r) => r.app_key && app.parts.has(r.app_key) && r.app_level === level);
    if (!roles.length) throw new HttpError(404, "Level not found");
    const label = levelLabel(roles[0]);
    for (const part of app.parts) {
      const mine = Object.fromEntries(Object.entries(perms).filter(([t]) => tables.get(t) === part));
      const role = roles.find((r) => r.app_key === part);
      if (role) await query(`UPDATE roles SET permissions = $2::jsonb, updated_at = now() WHERE _id = $1`, [role._id, JSON.stringify(mine)], client);
      else if (Object.keys(mine).length) await createLevelRole(part, level, label, mine, client);
    }
  });
  await invalidateSchemas();
}

// "Add a level", such as Accountant: no rights until you give some.
export async function addLevel(appKey: string, input: { name?: unknown }) {
  const app = await requireApp(appKey);
  const label = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!label) throw new HttpError(400, "Give the level a name");
  if (label.length > 40) throw new HttpError(400, "Keep the name under 40 characters");
  if (label.includes("·")) throw new HttpError(400, "The name can't contain ·");
  const level = slugify(label);
  if (BUILT_IN[level] || Object.values(BUILT_IN).some((b) => b.toLowerCase() === label.toLowerCase())) {
    throw new HttpError(409, `${app.name} already has ${label}`);
  }
  return withTransaction(async (client) => {
    const taken = (await loadRoles(client)).some((r) => r.app_key && app.parts.has(r.app_key) && (r.app_level === level || levelLabel(r).toLowerCase() === label.toLowerCase()));
    if (taken) throw new HttpError(409, `${app.name} already has a level called ${label}`);
    // one role per part of the app, so App access gives the level in all of them
    for (const part of app.parts) await createLevelRole(part, level, label, {}, client);
    return { level, name: label };
  });
}

// Remove a level you added. Its people lose it; approval steps and Ask Zenin
// that use it must be changed first.
export async function deleteLevel(appKey: string, level: string) {
  const app = await requireApp(appKey);
  if (BUILT_IN[level]) throw new HttpError(400, "Staff and Manager stay with the app");
  const roles = (await loadRoles()).filter((r) => r.app_key && app.parts.has(r.app_key) && r.app_level === level);
  if (!roles.length) throw new HttpError(404, "Level not found");
  const ids = new Set(roles.map((r) => r._id));
  for (const s of await getAllSchemas()) {
    for (const c of s.columns) {
      const o = (c.options ?? []).find((o) => o.roles?.some((id) => ids.has(id)));
      if (o) throw new HttpError(409, `Only this level can choose "${o.label}" in ${s.tableName}. Change that first.`);
    }
  }
  const { rows } = await query<{ value: { askRoles?: string[] } }>(`SELECT value FROM app_state WHERE key = 'ai'`);
  if (rows[0]?.value?.askRoles?.some((id) => ids.has(id))) throw new HttpError(409, "Ask Zenin is open to this level. Change that in Settings → AI first.");
  await query(`DELETE FROM roles WHERE _id = ANY($1::text[])`, [[...ids]]);
  await invalidateSchemas();
}

// Staff and Manager of a ready-made app back to what it came with. Tables
// you added to the app keep their rights.
export async function resetLevel(appKey: string, level: string) {
  const app = await requireApp(appKey);
  if (!BUILT_IN[level]) throw new HttpError(400, "Only Staff and Manager have defaults");
  const schemas = await getAllSchemas();
  await withTransaction(async (client) => {
    const roles = (await loadRoles(client)).filter((r) => r.app_key && app.parts.has(r.app_key) && r.app_level === level);
    for (const role of roles) {
      const defaults = defaultRolePerms(role.app_key!, level, schemas);
      if (!defaults) continue;
      const own = new Set(schemas.filter((s) => tableApp(s) === role.app_key && s.blueprintKey).map((s) => s.tableName));
      const kept = Object.fromEntries(Object.entries(role.permissions ?? {}).filter(([t]) => !own.has(t)));
      await query(`UPDATE roles SET permissions = $2::jsonb, updated_at = now() WHERE _id = $1`, [role._id, JSON.stringify({ ...kept, ...defaults })], client);
    }
  });
  await invalidateSchemas();
}

/* ------------------------------------------------------------------ */
/* moving older roles to levels, exactly                               */
/* ------------------------------------------------------------------ */

// What every person can do, as far as roles decide it: their rights per
// table, every limited choice option ("Approved"), Ask Zenin, whether they
// count as an app's Manager (reminders), and whether they can edit every
// record of a table (automations' "managers").
async function snapshot(client: pg.PoolClient, schemas: TableSchema[]) {
  const roles = new Map((await loadRoles(client)).map((r) => [r._id, r]));
  const held = await holdings(client);
  const ai = (await query<{ value: { askRoles?: string[] } }>(`SELECT value FROM app_state WHERE key = 'ai'`, [], client)).rows[0]?.value;
  const askRoles = ai?.askRoles ?? [];
  const options = schemas.flatMap((s) =>
    s.columns.flatMap((c) => (c.options ?? []).filter((o) => o.roles?.length).map((o) => ({ id: `${s.tableName}.${c.name}=${o.label}`, roles: o.roles! })))
  );
  const tables = new Set(schemas.map((s) => s.tableName));
  const byUser = new Map<string, string[]>();
  for (const h of held) byUser.set(h.user_id, [...(byUser.get(h.user_id) ?? []), h.role_id]);
  const out = new Map<string, unknown>();
  for (const [user, ids] of byUser) {
    const mine = ids.map((id) => roles.get(id)!).filter(Boolean);
    if (mine.some((r) => r.is_admin)) {
      out.set(user, "admin");
      continue;
    }
    out.set(user, {
      rights: only(mergePermissions(mine.map((r) => r.permissions ?? {})), tables),
      options: options.filter((o) => o.roles.some((id) => ids.includes(id))).map((o) => o.id).sort(),
      ask: !askRoles.length || ids.some((id) => askRoles.includes(id)),
      manages: [...new Set(mine.filter((r) => r.app_level === "manager").map((r) => r.app_key))].sort(),
      editsAll: [...tables].filter((t) => mine.some((r) => r.permissions?.[t]?.edit && !r.permissions?.[t]?.own)).sort(),
    });
  }
  return out;
}

export type MovePlan = {
  roles: { name: string; people: number; becomes: string[] }[];
  levels: { app: string; name: string; people: number }[];
};

class Preview extends Error {
  constructor(readonly plan: MovePlan) {
    super("preview");
  }
}

// Turn older roles into levels. apply=false shows what would happen, without
// changing anything; both check every person before and after.
export async function moveOlderRoles(apply: boolean): Promise<MovePlan & { moved: boolean }> {
  await loadDraftedApps();
  await ensureMyTables();
  try {
    const plan = await withTransaction(async (client) => {
      const schemas = await getAllSchemas();
      const apps = await launchers(client);
      const memberId = await memberRoleId(client);
      const roles = await loadRoles(client);
      const byId = new Map(roles.map((r) => [r._id, r]));
      const older = roles.filter((r) => isOlder(r, memberId));
      if (!older.length) return { roles: [], levels: [] };
      if (!memberId) throw new HttpError(500, "The Member role is missing");

      const before = await snapshot(client, schemas);
      const tableLauncher = new Map(schemas.map((s) => [s.tableName, launcherOf(tableApp(s))]));
      const tablePart = new Map(schemas.map((s) => [s.tableName, tableApp(s)]));
      const optionRefs = new Map<string, Set<string>>(); // role id -> launchers of tables whose options name it
      for (const s of schemas) for (const c of s.columns) for (const o of c.options ?? []) for (const id of o.roles ?? []) {
        optionRefs.set(id, (optionRefs.get(id) ?? new Set()).add(tableLauncher.get(s.tableName)!));
      }
      // the apps a role is about: where it has rights, or is named by an option
      const touches = (r: RoleRow) =>
        new Set([
          ...Object.keys(r.permissions ?? {}).filter((t) => r.permissions[t]?.view && tableLauncher.has(t)).map((t) => tableLauncher.get(t)!),
          ...(optionRefs.get(r._id) ?? []),
          ...(r.app_key ? [launcherOf(r.app_key)] : []),
        ]);

      const held = await holdings(client);
      const users = new Map<string, { main: string; extra: string[] }>();
      for (const h of held) {
        const u = users.get(h.user_id) ?? { main: "", extra: [] };
        if (h.main) u.main = h.role_id;
        else u.extra.push(h.role_id);
        users.set(h.user_id, u);
      }

      // Two ways, each checked: first reuse an app's existing level wherever it
      // gives exactly the same rights (Sales rep on top of Manager stays
      // Manager); if anyone would differ, undo that try and make new levels
      // for every role an approval step or Ask Zenin names. The check decides.
      const attempt = async (strict: boolean): Promise<MovePlan | HttpError> => {
        await query(`SAVEPOINT move_try`, [], client);
        const created = new Map<string, { app: string; label: string; ids: string[]; origin: string[]; people: Set<string> }>();
        // roles named by an approval step or Ask Zenin: they must stay traceable
        const aiNow = (await query<{ value: { askRoles?: string[] } }>(`SELECT value FROM app_state WHERE key = 'ai'`, [], client)).rows[0]?.value;
        const named = new Set([...(aiNow?.askRoles ?? []), ...optionRefs.keys()]);
        const tablesOfPart = (part: string) => new Set(schemas.filter((s) => tablePart.get(s.tableName) === part).map((s) => s.tableName));
        // an existing level of the app that already gives exactly the combined rights
        const sameLevel = (app: Launcher, origin: RoleRow[], merged: PermissionMap) => {
          const own = origin.filter((r) => r.app_key && app.parts.has(r.app_key));
          if (strict && origin.some((r) => !own.includes(r) && named.has(r._id))) return null;
          const candidates = [...new Set(own.map((r) => r.app_level!))].sort((a, b) => (a === "manager" ? -1 : b === "manager" ? 1 : 0));
          for (const lvl of candidates) {
            const lr = roles.filter((r) => r.app_key && app.parts.has(r.app_key) && r.app_level === lvl);
            const same = [...app.parts].every((part) =>
              sameJson(only(merged, tablesOfPart(part)), only(lr.find((r) => r.app_key === part)?.permissions ?? {}, tablesOfPart(part)))
            );
            if (same) return { level: lvl, ids: lr.map((r) => r._id), label: levelLabel(lr[0]) };
          }
          return null;
        };
        const levelsTaken = new Map<string, Set<string>>(); // launcher -> levels in use
        for (const r of roles) if (r.app_key) {
          const l = launcherOf(r.app_key);
          levelsTaken.set(l, (levelsTaken.get(l) ?? new Set()).add(r.app_level!));
        }
        const olderIds = new Set(older.map((r) => r._id));
        const becomes = new Map<string, Set<string>>(); // older role -> level names

        for (const [userId, u] of users) {
          const mine = [u.main, ...u.extra].map((id) => byId.get(id)!).filter((r) => r && !r.is_admin && r._id !== memberId);
          if (!mine.some((r) => olderIds.has(r._id))) continue;
          // the apps to redo: those an older role is about, and (repeatedly) those
          // any role taken off is about too, so nothing it gave goes missing
          const redo = new Set<string>();
          for (const r of mine.filter((r) => olderIds.has(r._id))) for (const l of touches(r)) redo.add(l);
          for (let grew = true; grew; ) {
            grew = false;
            for (const r of mine) {
              if (olderIds.has(r._id) || !r.app_key || !redo.has(launcherOf(r.app_key))) continue;
              for (const l of touches(r)) if (!redo.has(l)) (redo.add(l), (grew = true));
            }
          }
          const keep = u.extra.filter((id) => {
            const r = byId.get(id);
            return r && !olderIds.has(id) && !(r.app_key && redo.has(launcherOf(r.app_key)));
          });
          const add: string[] = [];
          for (const launcher of redo) {
            const app = apps.get(launcher);
            if (!app) continue;
            const origin = mine.filter((r) => touches(r).has(launcher)).sort((a, b) => a.name.localeCompare(b.name));
            if (!origin.length) continue;
            const key = `${launcher}|${origin.map((r) => r._id).join(",")}`;
            const merged0 = mergePermissions(origin.map((r) => r.permissions ?? {}));
            const existing = sameLevel(app, origin, merged0);
            if (existing) {
              add.push(...existing.ids);
              for (const r of origin.filter((r) => olderIds.has(r._id))) becomes.set(r._id, (becomes.get(r._id) ?? new Set()).add(`${app.name} · ${existing.label}`));
              continue;
            }
            // jobs that give exactly the same simple rights share one level, instead
            // of a level per job that all do the same: "Viewer" (only looking) or
            // "Own records" (only their own, such as expense claims)
            const appTables = new Set(app.tables.map((t) => t.tableName));
            const inApp = only(merged0, appTables);
            const entries = Object.values(inApp);
            const shareable = entries.length > 0 && !origin.some((r) => named.has(r._id)) && !origin.some((r) => r.app_key && app.parts.has(r.app_key));
            const kind = !shareable
              ? null
              : entries.every((p) => !p.create && !p.edit && !p.delete && !p.own)
                ? "viewer"
                : entries.every((p) => p.own)
                  ? "own"
                  : null;
            const viewKey = kind ? `${launcher}|${kind}|${JSON.stringify(sortKeys(inApp))}` : null;
            const finalKey = viewKey ?? key;
            let level = created.get(finalKey);
            if (level && viewKey) {
              level.origin = [...new Set([...level.origin, ...origin.map((r) => r._id)])];
              for (const r of origin.filter((r) => olderIds.has(r._id))) becomes.set(r._id, (becomes.get(r._id) ?? new Set()).add(`${app.name} · ${level.label}`));
            }
            if (!level) {
              const appRoles = origin.filter((r) => r.app_key && launcherOf(r.app_key) === launcher);
              const same = [...created.keys()].filter((k) => k.startsWith(`${launcher}|${kind}|`)).length;
              const names = Object.keys(inApp).map(readable);
              const label =
                kind === "viewer"
                  ? names.length === appTables.size
                    ? "Viewer (all tables)"
                    : names.length <= 3
                      ? `Viewer (${names.join(", ")})`
                      : `Viewer ${same + 1}`
                  : kind === "own"
                    ? same
                      ? `Own records ${same + 1}`
                      : "Own records"
                    : [...appRoles.map(levelLabel), ...origin.filter((r) => !appRoles.includes(r)).map((r) => r.name)]
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(" + ");
              const taken = levelsTaken.get(launcher) ?? new Set();
              let slug = slugify(label);
              for (let n = 2; taken.has(slug); n++) slug = `${slugify(label)}-${n}`;
              taken.add(slug);
              levelsTaken.set(launcher, taken);
              const merged = mergePermissions(origin.map((r) => r.permissions ?? {}));
              const ids: string[] = [];
              for (const part of app.parts) {
                const mineTables = new Set(schemas.filter((s) => tablePart.get(s.tableName) === part).map((s) => s.tableName));
                const perms = only(merged, mineTables);
                if (Object.keys(perms).length || part === [...app.parts][0]) ids.push(await createLevelRole(part, slug, label, perms, client));
              }
              level = { app: app.name, label, ids, origin: origin.map((r) => r._id), people: new Set() };
              created.set(finalKey, level);
              for (const r of origin.filter((r) => olderIds.has(r._id))) becomes.set(r._id, (becomes.get(r._id) ?? new Set()).add(`${app.name} · ${label}`));
            }
            level.people.add(userId);
            add.push(...level.ids);
          }
          const main = olderIds.has(u.main) ? memberId : u.main;
          await query(`UPDATE users SET role_id = $2 WHERE _id = $1`, [userId, main], client);
          await query(`DELETE FROM user_roles WHERE user_id = $1`, [userId], client);
          const extra = [...new Set([...keep, ...add])].filter((id) => id !== main);
          if (extra.length) await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::text[])`, [userId, extra], client);
        }

        // approval options and Ask Zenin: the new levels that came from a role named there
        const mapIds = (ids: string[]) => {
          const out = new Set(ids.filter((id) => !olderIds.has(id)));
          for (const level of created.values()) if (level.origin.some((id) => ids.includes(id))) level.ids.forEach((id) => out.add(id));
          return [...out];
        };
        for (const s of schemas) {
          if (!s.columns.some((c) => c.options?.some((o) => o.roles?.length))) continue;
          const columns = s.columns.map((c) => (c.options ? { ...c, options: c.options.map((o) => (o.roles?.length ? { ...o, roles: mapIds(o.roles) } : o)) } : c));
          await query(`UPDATE table_schemas SET columns = $2::jsonb WHERE table_name = $1`, [s.tableName, JSON.stringify(columns)], client);
        }
        const ai = (await query<{ value: { askRoles?: string[] } }>(`SELECT value FROM app_state WHERE key = 'ai'`, [], client)).rows[0]?.value;
        if (ai?.askRoles?.length) {
          await query(`UPDATE app_state SET value = value || $1::jsonb WHERE key = 'ai'`, [JSON.stringify({ askRoles: mapIds(ai.askRoles) })], client);
        }

        // a copy of the older roles, kept in case the move must be undone by hand
        await query(
          `INSERT INTO app_state (key, value) VALUES ('accessMoveBackup', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify({ at: new Date().toISOString(), roles: older, holdings: held, askRoles: ai?.askRoles ?? [] })],
          client
        );
        await query(`DELETE FROM user_roles WHERE role_id = ANY($1::text[])`, [[...olderIds]], client);
        await query(`DELETE FROM roles WHERE _id = ANY($1::text[])`, [[...olderIds]], client);

        // the check: every person can do exactly what they could before
        const after = await snapshot(client, await reloadSchemas(client));
        const differ = [...before.keys()].filter((u) => !sameJson(before.get(u), after.get(u)));
        if (differ.length) {
          const { rows } = await query<{ full_name: string; username: string }>(`SELECT full_name, username FROM users WHERE _id = ANY($1::text[]) LIMIT 5`, [differ], client);
          // what would change for the first of them, in plain words
          const was = before.get(differ[0]) as Record<string, unknown> | string;
          const now = after.get(differ[0]) as Record<string, unknown> | string;
          const WHAT: Record<string, string> = {
            rights: "their rights on tables",
            options: "the approval options they can choose",
            ask: "whether they can use Ask Zenin",
            manages: "the apps they manage",
            editsAll: "the tables they manage",
          };
          const parts =
            typeof was === "object" && typeof now === "object"
              ? Object.keys(WHAT).filter((k) => !sameJson(was[k], now[k])).map((k) => WHAT[k])
              : ["whether they're an admin"];
          await query(`ROLLBACK TO SAVEPOINT move_try`, [], client);
          return new HttpError(
            409,
            `Moving the older roles would change what ${differ.length} ${differ.length === 1 ? "person" : "people"} can do (${rows.map((r) => r.full_name || r.username).join(", ")}): ${parts.join(", ")}. Nothing was changed.`
          );
        }
        await query(`RELEASE SAVEPOINT move_try`, [], client);

        return {
          roles: older.map((r) => ({ name: r.name, people: new Set(held.filter((h) => h.role_id === r._id).map((h) => h.user_id)).size, becomes: [...(becomes.get(r._id) ?? [])].sort() })),
          levels: [...created.values()].map((l) => ({ app: l.app, name: l.label, people: l.people.size })).sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name)),
        };
      };
      let result = await attempt(false);
      if (result instanceof HttpError) result = await attempt(true);
      if (result instanceof HttpError) throw result;
      if (!apply) throw new Preview(result);
      return result;
    });
    await invalidateSchemas();
    forgetAiSettings();
    return { ...plan, moved: plan.roles.length > 0 };
  } catch (error) {
    if (error instanceof Preview) return { ...error.plan, moved: false };
    throw error;
  }
}

// option roles were rewritten inside the transaction: read them from there
async function reloadSchemas(client: pg.PoolClient): Promise<TableSchema[]> {
  const { rows } = await query<{ table_name: string; columns: TableSchema["columns"] }>(`SELECT table_name, columns FROM table_schemas`, [], client);
  return rows.map((r) => ({ tableName: r.table_name, columns: r.columns }) as TableSchema);
}

export type { Permissions };
