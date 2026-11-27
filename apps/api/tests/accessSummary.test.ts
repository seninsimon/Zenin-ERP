import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// "What they can do" (GET /users/:id/access) and "Who can use this table"
// (GET /schema/:table/access): plain answers for admins, from the same rules
// the server enforces. See docs/WORKFLOW.md.
describe("Access summaries", async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const eng = await dept("Eng");
  const hr = await dept("HR");

  const table = async (name: string, departmentIds?: string[]) => {
    const t = unique(name);
    await admin.post("/api/schema", { tableName: t, columns: [{ name: "title", label: "Title" }, { name: "owner", label: "Owner", type: "user" }] }).expect(200);
    if (departmentIds) await admin.put(`/api/schema/${t}`, { departmentIds }).expect(200);
    else await admin.put(`/api/schema/${t}`, { byDepartment: false }).expect(200);
    return t;
  };
  const tickets = await table("tickets", [eng._id, hr._id]); // split by department
  const leave = await table("leave"); // everyone with access
  const payroll = await table("payroll", [hr._id]); // split, HR only
  const secret = await table("secret"); // nobody's role has it

  const role = (await admin.post("/api/roles", {
    name: unique("Work"),
    permissions: {
      [tickets]: { view: true, create: true },
      [leave]: { view: true, create: true, edit: true, own: true },
      [payroll]: { view: true },
    },
  })).body.role;
  const username = unique("asha").toLowerCase();
  const asha = (await admin.post("/api/users", { username, fullName: "Asha", password: "pass-123-pass", roleId: role._id, departmentIds: [eng._id] }).expect(201)).body.user;

  const summary = async () => (await admin.get(`/api/users/${asha._id}/access`).expect(200)).body;
  const row = (s: { tables: { tableName: string }[] }, t: string) => s.tables.find((x) => x.tableName === t) as Record<string, unknown>;

  it("says what a person can do on each table, and why not", async () => {
    const s = await summary();
    expect(s).toMatchObject({ admin: false, role: role.name, departments: [eng.name] });
    // split table: they see their department's records only
    expect(row(s, tickets)).toMatchObject({ view: true, create: true, edit: false, delete: false, own: false, departments: [eng.name] });
    // own only: their own records, whatever the department
    expect(row(s, leave)).toMatchObject({ view: true, create: true, edit: true, own: true, departments: null });
    // their role allows it, but they're not in HR: that's the reason
    expect(row(s, payroll)).toMatchObject({ view: false, needsDepartment: [hr.name] });
    // not given at all: no reason to show
    expect(row(s, secret)).toMatchObject({ view: false });
    expect(row(s, secret).needsDepartment).toBeUndefined();
  });

  it("matches what the person really gets from the server", async () => {
    const me = await login(username, "pass-123-pass");
    const real = ((await me.get("/api/schema").expect(200)).body as { tableName: string; permissions: Record<string, boolean> }[])
      .map((t) => ({ tableName: t.tableName, view: t.permissions.view, create: t.permissions.create, edit: t.permissions.edit, delete: t.permissions.delete }))
      .sort((a, b) => a.tableName.localeCompare(b.tableName));
    const said = ((await summary()).tables as { tableName: string; view: boolean; create: boolean; edit: boolean; delete: boolean }[])
      .filter((t) => t.view)
      .map(({ tableName, view, create, edit, delete: del }) => ({ tableName, view, create, edit, delete: del }))
      .sort((a, b) => a.tableName.localeCompare(b.tableName));
    expect(said).toEqual(real);
  });

  it("follows changes at once", async () => {
    await admin.put(`/api/users/${asha._id}`, { departmentIds: [eng._id, hr._id] }).expect(200);
    const s = await summary();
    expect(row(s, payroll)).toMatchObject({ view: true, departments: [hr.name] });
    expect((row(s, tickets).departments as string[]).sort()).toEqual([eng.name, hr.name].sort());
    await admin.put(`/api/users/${asha._id}`, { departmentIds: [eng._id] }).expect(200);
  });

  it("an admin can do everything; only admins may ask", async () => {
    const me = (await admin.get("/api/auth/me")).body.user ?? (await admin.get("/api/auth/me")).body;
    const s = (await admin.get(`/api/users/${me._id}/access`).expect(200)).body;
    expect(s).toMatchObject({ admin: true, tables: [] });
    const asAsha = await login(username, "pass-123-pass");
    expect((await asAsha.get(`/api/users/${asha._id}/access`)).status).toBe(403);
    expect((await asAsha.get(`/api/schema/${tickets}/access`)).status).toBe(403);
    expect((await admin.get("/api/users/00000000-0000-0000-0000-000000000000/access")).status).toBe(404);
  });

  it("lists who can use a table, with how many people", async () => {
    const t = (await admin.get(`/api/schema/${leave}/access`).expect(200)).body;
    expect(t.admins).toBeGreaterThanOrEqual(1);
    expect(t.splitByDepartment).toBe(false);
    expect(t.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleId: role._id, name: role.name, create: true, edit: true, delete: false, own: true, people: 1 }),
        // the table is in My tables, whose Manager has everything (nobody has it yet)
        expect.objectContaining({ name: "My tables · Manager", appKey: "my-tables", delete: true, people: 0 }),
      ])
    );
    const p = (await admin.get(`/api/schema/${payroll}/access`).expect(200)).body;
    expect(p).toMatchObject({ splitByDepartment: true, departments: [hr.name] });
    // nobody's own role has it: only the app's Manager role
    expect((await admin.get(`/api/schema/${secret}/access`).expect(200)).body.roles.map((r: { name: string }) => r.name)).toEqual(["My tables · Manager"]);
  });

  it("won't split a table by department with no department", async () => {
    const res = await admin.put(`/api/schema/${secret}`, { byDepartment: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one department/);
    expect((await admin.put(`/api/schema/${tickets}`, { departmentIds: [] })).status).toBe(400);
    // with a department it's fine, and so is everyone-with-access with none
    await admin.put(`/api/schema/${secret}`, { byDepartment: true, departmentIds: [hr._id] }).expect(200);
    await admin.put(`/api/schema/${secret}`, { byDepartment: false, departmentIds: [] }).expect(200);
    // other settings on an old split table without departments still save
    const old = unique("old");
    await admin.post("/api/schema", { tableName: old, columns: [{ name: "title", label: "Title" }] }).expect(200);
    await admin.put(`/api/schema/${old}`, { showInMenu: false }).expect(200);
  });
});
