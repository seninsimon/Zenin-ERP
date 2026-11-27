import { z } from "zod";
import { rolesForAccess } from "../apps/access.js";
import { launcherApp } from "../apps/index.js";
import { isAdmin } from "../auth/access.js";
import { personAccess, tableAccess, type TableAccess } from "../auth/accessSummary.js";
import { addLevel, listLevels, saveLevel } from "../auth/levels.js";
import { mergePermissions } from "../auth/mergePermissions.js";
import { HttpError } from "../lib/http.js";
import { listDepartments, listRoles, listUsers, updateUser } from "../repo/userRepo.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { CurrentUser, PermissionMap, Permissions } from "../types.js";
import { metered } from "./generate.js";
import { activeAi, getAiSettings } from "./settings.js";
import { checkLimits } from "./usage.js";
import { cleanTurns } from "./assistant.js";
import { chatWithTools, type ToolDef, type ToolResult } from "./toolChat.js";

// Change access with AI (docs/WORKFLOW.md), for admins. The
// admin says what they want ("let Senin edit leave requests"); the AI looks
// things up with read-only tools and suggests changes. A suggestion is worked
// out here, in memory, with the same rules that decide access, so the
// preview says exactly what changes for whom. Nothing is saved until the
// admin presses Apply, which goes through the normal admin functions.
// The AI can't make anyone an Administrator: there's no change for it.

/* ---------------- the changes it may suggest ---------------- */

const RIGHTS = {
  none: null,
  view: { view: true, create: false, edit: false, delete: false },
  add: { view: true, create: true, edit: false, delete: false },
  work: { view: true, create: true, edit: true, delete: false },
  all: { view: true, create: true, edit: true, delete: true },
} as const;
const Rights = z.enum(["none", "view", "add", "work", "all"]);

const Change = z.discriminatedUnion("kind", [
  // a person's level in one app ("none" takes the app away)
  z.object({ kind: z.literal("set_app_level"), person_id: z.string(), app: z.string(), level: z.string() }),
  // what one level may do in one table (everyone with the level gets it)
  z.object({ kind: z.literal("set_level_rights"), app: z.string(), level: z.string(), table: z.string(), rights: Rights, own: z.boolean().optional() }),
  // a new level, with its rights, given to some people
  z.object({
    kind: z.literal("add_level"),
    app: z.string(),
    name: z.string().max(40),
    tables: z.array(z.object({ table: z.string(), rights: Rights, own: z.boolean().optional() })).max(50),
    give_to: z.array(z.string()).max(50),
  }),
  // a person's departments (the teams they're in), by name
  z.object({ kind: z.literal("set_departments"), person_id: z.string(), departments: z.array(z.string()).max(20) }),
]);
export type AccessChange = z.infer<typeof Change>;
const Proposal = z.object({ summary: z.string().max(400), changes: z.array(Change).min(1).max(20) });

/* ---------------- the company, in memory ---------------- */

type Role = { _id: string; name: string; isAdmin: boolean; appKey: string | null; appLevel: string | null; permissions: PermissionMap };
type Model = {
  users: CurrentUser[];
  roles: Map<string, Role>;
  holds: Map<string, string[]>; // person -> every role (main first)
  depts: Map<string, { _id: string; name: string }[]>;
  departments: { _id: string; name: string }[];
  apps: Awaited<ReturnType<typeof listLevels>>["apps"];
  // table -> the app part that holds it (Company has three parts)
  tableParts: Map<string, string>;
};

async function load(): Promise<Model> {
  const [users, roles, departments, levels] = [await listUsers(), await listRoles(), await listDepartments(), await listLevels()];
  return {
    users,
    roles: new Map(roles.map((r) => [r._id, { ...r, permissions: { ...(r.permissions ?? {}) } }])),
    holds: new Map(users.map((u) => [u._id, [...u.roleIds]])),
    depts: new Map(users.map((u) => [u._id, u.departments])),
    departments: departments.map((d) => ({ _id: d._id, name: d.name })),
    apps: levels.apps,
    tableParts: new Map(),
  };
}

const clone = (m: Model): Model => ({
  ...m,
  roles: new Map([...m.roles].map(([k, r]) => [k, { ...r, permissions: { ...r.permissions } }])),
  holds: new Map([...m.holds].map(([k, v]) => [k, [...v]])),
  depts: new Map(m.depts),
});

// the person as the access rules see them, in this version of the company
function personIn(m: Model, user: CurrentUser): CurrentUser {
  const ids = m.holds.get(user._id) ?? [];
  const roles = ids.map((id) => m.roles.get(id)).filter((r): r is Role => Boolean(r));
  const main = m.roles.get(ids[0]) ?? m.roles.get(user.role._id)!;
  return {
    ...user,
    role: { _id: main._id, name: main.name, isAdmin: main.isAdmin, permissions: mergePermissions(roles.map((r) => r.permissions)) },
    roleIds: ids,
    appRoles: roles.filter((r) => r.appKey && r.appLevel).map((r) => ({ _id: r._id, appKey: r.appKey!, appLevel: r.appLevel! })),
    departments: m.depts.get(user._id) ?? [],
  };
}

const norm = (v: string) => v.trim().toLowerCase();
const findApp = (m: Model, v: string) => {
  const app = m.apps.find((a) => norm(a.key) === norm(v) || norm(a.name) === norm(v));
  if (!app) throw new HttpError(400, `There's no app "${v}". Apps: ${m.apps.map((a) => `${a.name} (${a.key})`).join(", ")}`);
  return app;
};
const tableTitle = (t: string) => t.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const findTable = (app: Model["apps"][number], v: string) => {
  const t = app.tables.find((x) => norm(x) === norm(v) || norm(tableTitle(x)) === norm(v));
  if (!t) throw new HttpError(400, `${app.name} has no table "${v}". Its tables: ${app.tables.join(", ")}`);
  return t;
};
const findLevel = (app: Model["apps"][number], v: string) => {
  const l = app.levels.find((x) => norm(x.level) === norm(v) || norm(x.name) === norm(v));
  if (!l) throw new HttpError(400, `${app.name} has no level "${v}". Its levels: ${app.levels.map((x) => `${x.name} (${x.level})`).join(", ")}`);
  return l;
};
const findPerson = (m: Model, id: string) => {
  const u = m.users.find((x) => x._id === id);
  if (!u) throw new HttpError(400, `No person with id ${id}. Use find_people first.`);
  return u;
};
const nameOf = (u: CurrentUser) => u.fullName || u.username;
const partOf = (m: Model, table: string) => m.tableParts.get(table) ?? "my-tables";
// the role of this level in the app part that holds the table
const partRole = (m: Model, level: string, table: string) =>
  [...m.roles.values()].find((r) => r.appLevel === level && r.appKey === partOf(m, table));

const toPerm = (rights: keyof typeof RIGHTS, own?: boolean): Permissions | null => {
  const p = RIGHTS[rights];
  return p ? { ...p, ...(own ? { own: true } : {}) } : null;
};

/* ---------------- working out a suggestion ---------------- */

export type Preview = {
  summary: string;
  steps: string[];
  people: { name: string; lines: string[] }[];
  warnings: string[];
};

const words = (t: TableAccess | undefined) => {
  if (!t?.view) return t?.needsDepartment ? `no access (needs ${t.needsDepartment.join(" or ") || "a department"})` : "no access";
  const verbs = [t.create && "add", t.edit && "edit", t.delete && "delete"].filter(Boolean) as string[];
  const can = t.create && t.edit && t.delete ? "everything" : verbs.length ? `view, ${verbs.join(", ")}` : "view only";
  const scope = t.own ? "only their own" : t.departments ? `only ${t.departments.join(" or ")}'s records` : "all records";
  return `${can}, ${scope}`;
};

// what a level may do in one table, in words
const levelWords = (p: Permissions | undefined) => {
  if (!p?.view) return "no access";
  const verbs = [p.create && "add", p.edit && "edit", p.delete && "delete"].filter(Boolean) as string[];
  return `${p.create && p.edit && p.delete ? "everything" : verbs.length ? `view, ${verbs.join(", ")}` : "view only"}${p.own ? ", only their own" : ""}`;
};

// Apply the changes to a copy of the company; say what each one does, and
// what changes for every person it touches. Throws (400) on anything invalid.
async function simulate(before: Model, raw: unknown): Promise<{ after: Model; preview: Preview; changes: AccessChange[] }> {
  const parsed = Proposal.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid changes: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const m = clone(before);
  const steps: string[] = [];
  const warnings: string[] = [];
  const touched = new Set<string>();
  const holdersOf = (appKey: string, level: string) =>
    m.users.filter((u) => (m.holds.get(u._id) ?? []).some((id) => {
      const r = m.roles.get(id);
      return r?.appLevel === level && r.appKey && launcherOfRole(m, r) === appKey;
    }));

  const setLevel = (user: CurrentUser, app: Model["apps"][number], level: string | null) => {
    const ids = (m.holds.get(user._id) ?? []).filter((id) => {
      const r = m.roles.get(id);
      return !(r?.appKey && launcherOfRole(m, r) === app.key);
    });
    if (level) for (const r of m.roles.values()) if (r.appLevel === level && r.appKey && launcherOfRole(m, r) === app.key) ids.push(r._id);
    m.holds.set(user._id, ids);
    touched.add(user._id);
  };

  for (const c of parsed.data.changes) {
    if (c.kind === "set_app_level") {
      const user = findPerson(m, c.person_id);
      if (isAdmin(personIn(m, user))) throw new HttpError(400, `${nameOf(user)} is an Administrator and can already do everything.`);
      const app = findApp(m, c.app);
      const was = app.levels.find((l) => holdersOf(app.key, l.level).some((u) => u._id === user._id))?.name ?? "No access";
      if (norm(c.level) === "none" || norm(c.level) === "no access") {
        setLevel(user, app, null);
        steps.push(`${nameOf(user)}: no access to ${app.name} (was ${was})`);
      } else {
        const level = findLevel(app, c.level);
        setLevel(user, app, level.level);
        steps.push(`${nameOf(user)}: ${level.name} in ${app.name} (was ${was})`);
        if (level.level === "manager" && app.managerNote) warnings.push(`${nameOf(user)} as ${app.name} Manager: ${app.managerNote}`);
      }
    } else if (c.kind === "set_level_rights") {
      const app = findApp(m, c.app);
      const level = findLevel(app, c.level);
      const table = findTable(app, c.table);
      const role = partRole(m, level.level, table);
      if (!role) throw new HttpError(400, `${app.name} ${level.name} has no role for ${table}`);
      const perm = toPerm(c.rights, c.own);
      if (perm) role.permissions[table] = perm;
      else delete role.permissions[table];
      const people = holdersOf(app.key, level.level);
      people.forEach((u) => touched.add(u._id));
      steps.push(
        `${app.name} ${level.name}: ${tableTitle(table)} → ${c.rights === "none" ? "no access" : c.rights === "all" ? "everything" : c.rights === "work" ? "view, add and edit" : c.rights === "add" ? "view and add" : "view only"}${c.own ? ", only their own" : ""}. Affects everyone with this level: ${people.length ? people.map(nameOf).join(", ") : "nobody yet"}.`
      );
    } else if (c.kind === "add_level") {
      const app = findApp(m, c.app);
      const label = c.name.trim().replace(/\s+/g, " ");
      if (!label || label.includes("·")) throw new HttpError(400, "Give the new level a plain name");
      if (["staff", "manager"].includes(norm(label)) || app.levels.some((l) => norm(l.name) === norm(label))) {
        throw new HttpError(400, `${app.name} already has a level called ${label}. Use it instead.`);
      }
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "level";
      // one new role per part of the app that holds a table here
      const perms = new Map<string, PermissionMap>();
      for (const t of c.tables) {
        const table = findTable(app, t.table);
        const perm = toPerm(t.rights, t.own);
        const part = partOf(m, table);
        const map = perms.get(part) ?? {};
        if (perm) map[table] = perm;
        perms.set(part, map);
      }
      if (!perms.size) perms.set(partOf(m, app.tables[0]), {});
      for (const [part, map] of perms) {
        const id = `new:${part}:${slug}`;
        m.roles.set(id, { _id: id, name: `${app.name} · ${label}`, isAdmin: false, appKey: part, appLevel: slug, permissions: map });
      }
      m.apps = m.apps.map((a) => (a.key === app.key ? { ...a, levels: [...a.levels, { level: slug, name: label, custom: true, people: 0, permissions: {} }] } : a));
      const appNow = m.apps.find((a) => a.key === app.key)!;
      const given = c.give_to.map((id) => findPerson(m, id));
      for (const u of given) {
        if (isAdmin(personIn(m, u))) throw new HttpError(400, `${nameOf(u)} is an Administrator and can already do everything.`);
        setLevel(u, appNow, slug);
      }
      steps.push(
        `New level in ${app.name}: ${label} (${c.tables.map((t) => `${tableTitle(t.table)}: ${t.rights}${t.own ? ", own" : ""}`).join("; ") || "no access yet"})${given.length ? `, given to ${given.map(nameOf).join(", ")}` : ""}`
      );
    } else {
      const user = findPerson(m, c.person_id);
      const chosen = c.departments.map((name) => {
        const d = m.departments.find((x) => norm(x.name) === norm(name));
        if (!d) throw new HttpError(400, `There's no department "${name}". Departments: ${m.departments.map((x) => x.name).join(", ")}`);
        return d;
      });
      const was = (m.depts.get(user._id) ?? []).map((d) => d.name);
      m.depts.set(user._id, chosen);
      touched.add(user._id);
      steps.push(`${nameOf(user)}: departments ${chosen.map((d) => d.name).join(", ") || "none"} (was ${was.join(", ") || "none"})`);
    }
  }

  // what changes for each person, table by table, in the same words as "What they can do"
  const people: Preview["people"] = [];
  for (const id of touched) {
    const user = m.users.find((u) => u._id === id)!;
    const was = await personAccess(personIn(before, user));
    const now = await personAccess(personIn(m, user));
    const lines: string[] = [];
    for (const t of now.tables) {
      const a = words(was.tables.find((x) => x.tableName === t.tableName));
      const b = words(t);
      if (a !== b) lines.push(`${tableTitle(t.tableName)}: ${a} → ${b}`);
    }
    people.push({ name: nameOf(user), lines: lines.length ? lines : ["No change in what they can do"] });
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { after: m, preview: { summary: parsed.data.summary, steps, people, warnings }, changes: parsed.data.changes };
}

// the app a role is shown under ("company" for People's roles), as everywhere else
const launcherOfRole = (_m: Model, r: Role) => launcherApp(r.appKey === "my-tables" ? null : r.appKey)?.key ?? r.appKey!;

async function prepare() {
  const m = await load();
  for (const a of m.apps) for (const t of a.tables) m.tableParts.set(t, (await getSchema(t))?.appKey ?? "my-tables");
  return m;
}

/* ---------------- the conversation ---------------- */

const TOOLS: ToolDef[] = [
  {
    name: "find_people",
    description: "Find people by part of their name or username. Returns their ids, names, Administrator or not, and departments.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "what_can_they_do",
    description: "What one person can do now: their level in each app, and table by table, in plain words. Also says why a table is closed.",
    parameters: { type: "object", properties: { person_id: { type: "string" } }, required: ["person_id"] },
  },
  {
    name: "who_can_use",
    description: "Who can use one table: every level that opens it, what it may do, and how many people have it.",
    parameters: { type: "object", properties: { table: { type: "string", description: "the table's key" } }, required: ["table"] },
  },
  {
    name: "app_levels",
    description: "One app's levels: what each may do in each of its tables, and who has it.",
    parameters: { type: "object", properties: { app: { type: "string", description: "the app's key or name" } }, required: ["app"] },
  },
  {
    name: "propose_changes",
    description:
      "Suggest changes. Nothing is saved: you get back a preview of exactly what changes for each person, and the admin decides. " +
      "Call it again with different changes if the preview isn't what was asked (for example, it affects more people than intended). " +
      "Kinds: set_app_level {person_id, app, level ('none' to remove)}; set_level_rights {app, level, table, rights, own?} " +
      "(changes the level for EVERYONE who has it); add_level {app, name, tables:[{table, rights, own?}], give_to:[person_id]}; " +
      "set_departments {person_id, departments:[names]}. rights: none, view, add (view and add), work (view, add and edit), all (everything). " +
      "own: only their own records.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "one short sentence for the admin: what this does" },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_app_level", "set_level_rights", "add_level", "set_departments"] },
              person_id: { type: "string" },
              app: { type: "string" },
              level: { type: "string" },
              table: { type: "string" },
              rights: { type: "string", enum: ["none", "view", "add", "work", "all"] },
              own: { type: "boolean" },
              name: { type: "string" },
              tables: {
                type: "array",
                items: {
                  type: "object",
                  properties: { table: { type: "string" }, rights: { type: "string", enum: ["none", "view", "add", "work", "all"] }, own: { type: "boolean" } },
                  required: ["table", "rights"],
                },
              },
              give_to: { type: "array", items: { type: "string" } },
              departments: { type: "array", items: { type: "string" } },
            },
            required: ["kind"],
          },
        },
      },
      required: ["summary", "changes"],
    },
  },
];

const SYSTEM = `You help an administrator of a business system change who can do what. Answer in short, plain English.

How access works:
- Everything is in apps. In each app a person has one level: Staff, Manager, or a level the company added. Or they are an Administrator, who can do everything.
- A level says what it may do in each of the app's tables: no access, view, view and add, view add and edit, or everything; and whether only in their own records.
- Departments are teams. They only limit records on tables split by department.

How to work:
- Questions ("what can Asha do?", "who can see Payroll?"): look it up with the tools and answer. Don't suggest changes unless asked.
- Changes: use the tools to see the current state, then call propose_changes. You never apply anything; the admin sees your suggestion with a preview and decides.
- Choose the smallest change that does exactly what was asked:
  1. If an existing level of the app gives exactly what's needed, give the person that level (set_app_level).
  2. If the request is about one person (or a few), don't change a level that others have: that changes it for all of them. Add a small new level for them instead (add_level), copying what their current level allows and adding what was asked.
  3. Change a level's rights (set_level_rights) only when the admin asks for everyone with that level, or when nobody else has it.
- Read the preview you get back. If it affects people it shouldn't, try again.
- You can't make anyone an Administrator, and can't change Administrators. If asked, say an admin can switch it on in their person dialog.
- After propose_changes, tell the admin in one or two sentences what you suggest and that nothing changes until they press Apply. Never say it's done.
- Use people's ids from find_people; never guess ids.`;

async function context(m: Model) {
  const apps = m.apps.map((a) => `- ${a.name} (key ${a.key}): tables ${a.tables.join(", ") || "none"}; levels ${a.levels.map((l) => `${l.name} (${l.level}, ${l.people} people)`).join(", ")}`).join("\n");
  return `${SYSTEM}\n\nApps:\n${apps}\n\nDepartments: ${m.departments.map((d) => d.name).join(", ") || "none"}`;
}

export type AccessAnswer = { answer: string; proposal: (Preview & { changes: AccessChange[] }) | null };

export async function canUseAccessAi(user: CurrentUser) {
  const s = await getAiSettings();
  return isAdmin(user) && Boolean(s.keys[s.provider]) && s.features.accessAi;
}

export async function askAccess(admin: CurrentUser, rawTurns: unknown): Promise<AccessAnswer> {
  if (!(await canUseAccessAi(admin))) throw new HttpError(403, "Change access with AI isn't switched on. An admin can switch it on in Administration → AI.");
  const turns = cleanTurns(rawTurns);
  const ai = await activeAi();
  if (!ai) throw new HttpError(503, "AI features aren't set up.");
  const who = { _id: admin._id, isAdmin: true };
  await checkLimits(who);
  const m = await prepare();
  let proposal: AccessAnswer["proposal"] = null;

  const run = async (name: string, input: unknown): Promise<ToolResult> => {
    const args = (input ?? {}) as Record<string, unknown>;
    try {
      if (name === "find_people") {
        const q = norm(String(args.name ?? ""));
        const found = m.users
          .filter((u) => norm(nameOf(u)).includes(q) || norm(u.username).includes(q))
          .slice(0, 10)
          .map((u) => ({ id: u._id, name: nameOf(u), username: u.username, administrator: isAdmin(u), active: u.isActive, departments: u.departments.map((d) => d.name) }));
        return { text: JSON.stringify(found), isError: false };
      }
      if (name === "what_can_they_do") {
        const u = findPerson(m, String(args.person_id ?? ""));
        const a = await personAccess(u);
        if (a.admin) return { text: `${nameOf(u)} is an Administrator: everything.`, isError: false };
        const tables = a.tables.map((t) => `${tableTitle(t.tableName)}${t.app ? ` (${t.app.name})` : ""}: ${words(t)}`);
        return { text: JSON.stringify({ name: nameOf(u), departments: a.departments, appLevels: a.appLevels, tables }), isError: false };
      }
      if (name === "who_can_use") {
        const schema = await getSchema(String(args.table ?? ""));
        if (!schema) return { text: `No table "${args.table}"`, isError: true };
        return { text: JSON.stringify(await tableAccess(schema)), isError: false };
      }
      if (name === "app_levels") {
        const app = findApp(m, String(args.app ?? ""));
        const levels = app.levels.map((l) => ({
          level: l.level,
          name: l.name,
          people: l.people,
          tables: Object.fromEntries(app.tables.map((t) => [t, levelWords(l.permissions[t])])),
        }));
        return { text: JSON.stringify({ app: app.name, key: app.key, tables: app.tables, levels }), isError: false };
      }
      if (name === "propose_changes") {
        const { preview, changes } = await simulate(m, args);
        proposal = { ...preview, changes };
        return { text: JSON.stringify(preview), isError: false };
      }
      return { text: `Unknown tool ${name}`, isError: true };
    } catch (error) {
      if (error instanceof HttpError) return { text: error.message, isError: true };
      throw error;
    }
  };

  const system = await context(m);
  const answer = await metered(ai, "accessAi", who, (meter) => chatWithTools({ system, turns, ai, meter, tools: TOOLS, runTool: run, maxRounds: 8 }));
  return { answer, proposal };
}

/* ---------------- Apply ---------------- */

// Apply suggested changes: checked again from scratch (the company may have
// changed since the preview), then saved with the normal admin functions.
export async function applyAccess(raw: unknown, onEach: (change: AccessChange, text: string) => Promise<void>) {
  const m = await prepare();
  const { preview, changes } = await simulate(m, raw);
  for (const [i, c] of changes.entries()) {
    if (c.kind === "set_app_level") {
      const app = findApp(m, c.app);
      const user = findPerson(m, c.person_id);
      const level = norm(c.level) === "none" || norm(c.level) === "no access" ? null : findLevel(app, c.level).level;
      const extra = (await listUsers()).find((u) => u._id === user._id)!.roleIds.slice(1);
      await updateUser(user._id, { extraRoleIds: await rolesForAccess(extra, { [app.key]: level }) });
    } else if (c.kind === "set_level_rights") {
      const app = findApp(m, c.app);
      const level = findLevel(app, c.level);
      const table = findTable(app, c.table);
      const now = (await listLevels()).apps.find((a) => a.key === app.key)!.levels.find((l) => l.level === level.level)!.permissions;
      const perm = toPerm(c.rights, c.own);
      const next = { ...now };
      if (perm) next[table] = perm;
      else delete next[table];
      await saveLevel(app.key, level.level, next);
    } else if (c.kind === "add_level") {
      const app = findApp(m, c.app);
      const added = await addLevel(app.key, { name: c.name });
      const perms: PermissionMap = {};
      for (const t of c.tables) {
        const perm = toPerm(t.rights, t.own);
        if (perm) perms[findTable(app, t.table)] = perm;
      }
      await saveLevel(app.key, added.level, perms);
      for (const id of c.give_to) {
        const extra = (await listUsers()).find((u) => u._id === id)!.roleIds.slice(1);
        await updateUser(id, { extraRoleIds: await rolesForAccess(extra, { [app.key]: added.level }) });
      }
    } else {
      const user = findPerson(m, c.person_id);
      const ids = c.departments.map((name) => m.departments.find((d) => norm(d.name) === norm(name))!._id);
      await updateUser(user._id, { departmentIds: ids });
    }
    await onEach(c, preview.steps[i]);
  }
  return preview;
}
