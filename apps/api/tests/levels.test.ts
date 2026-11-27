import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Access levels (docs/WORKFLOW.md): each app's Staff, Manager
// and added levels, and moving older roles (roles of no app) to levels,
// exactly: every person can do what they could before, or nothing changes.
describe("Access levels", async () => {
  const admin = await login();
  type Level = { level: string; name: string; custom: boolean; people: number; permissions: Record<string, Record<string, boolean>> };
  type AppLevels = { key: string; name: string; tables: string[]; levels: Level[]; resettable: boolean; managerNote: string | null };
  const levels = async () => (await admin.get("/api/access-levels").expect(200)).body as { apps: AppLevels[]; olderRoles: { _id: string; name: string; people: number }[]; admins: number };
  const app = async (key: string) => (await levels()).apps.find((a) => a.key === key)!;
  const roles = async () => (await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null; appLevel: string | null; isAdmin: boolean }[];
  const memberId = (await roles()).find((r) => r.name === "Member" && !r.appKey)!._id;
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;

  // a company with every unusual case
  // (an earlier test file may have added it already)
  const added = ((await admin.get("/api/apps")).body.apps as { key: string; installed: unknown }[]).some((a) => a.key === "expenses" && a.installed);
  if (!added) await admin.post("/api/apps/install", { apps: ["expenses"] }).expect(200);
  const claims = ((await admin.get("/api/schema")).body as { tableName: string; blueprintKey: string | null }[]).find((t) => t.blueprintKey === "expenses.claims")!.tableName;
  const north = await dept("North");
  const south = await dept("South");
  const orders = unique("orders");
  const tickets = unique("tickets");
  await admin.post("/api/schema", {
    tableName: orders,
    byDepartment: false,
    columns: [
      { name: "title", label: "Title" },
      { name: "status", label: "Status", type: "choice", options: [{ label: "New" }, { label: "Approved" }] },
    ],
  }).expect(200);
  await admin.post("/api/schema", { tableName: tickets, columns: [{ name: "title", label: "Title" }] }).expect(200);
  await admin.put(`/api/schema/${tickets}`, { byDepartment: true, departmentIds: [north._id, south._id] }).expect(200);

  const role = async (name: string, permissions: object) => (await admin.post("/api/roles", { name: unique(name), permissions }).expect(201)).body.role;
  const salesRep = await role("Sales rep", {
    [orders]: { view: true, create: true, edit: true },
    [claims]: { view: true, create: true, own: true },
  });
  const ops = await role("Ops", { [orders]: { view: true, edit: true }, [tickets]: { view: true, create: true, edit: true, delete: true } });
  const approver = await role("Approver", {}); // only an approval step names it
  await admin
    .put(`/api/schema/${orders}/column/status`, { options: [{ label: "New" }, { label: "Approved", roles: [approver._id] }] })
    .expect(200);

  const person = async (main: string, appAccess: Record<string, string> = {}, departmentIds: string[] = []) => {
    const username = unique("u").toLowerCase();
    const res = await admin.post("/api/users", { username, password: "pass-123-pass", roleId: main, appAccess, departmentIds }).expect(201);
    return { id: res.body.user._id as string, client: await login(username, "pass-123-pass") };
  };
  const rep = await person(salesRep._id);
  const opsStaff = await person(ops._id, { expenses: "staff" }, [north._id]);
  const repManager = await person(salesRep._id, { expenses: "manager" });
  const approverPerson = await person(approver._id, {}, [south._id]);
  const plain = await person(memberId, { expenses: "staff" });

  const rights = async (who: { client: Awaited<ReturnType<typeof login>> }) =>
    Object.fromEntries(
      ((await who.client.get("/api/schema")).body as { tableName: string; permissions: Record<string, boolean> }[]).map((t) => [t.tableName, t.permissions])
    );
  const everyone = [rep, opsStaff, repManager, approverPerson, plain];

  it("each app has Staff and Manager; you can add a level and give it rights", async () => {
    const exp = await app("expenses");
    expect(exp.levels.map((l) => l.name).slice(0, 2)).toEqual(["Staff", "Manager"]);
    expect(exp.managerNote).toMatch(/expense claims/);
    expect(exp.resettable).toBe(true);
    const added = (await admin.post("/api/access-levels/expenses", { name: "Accountant" }).expect(201)).body;
    expect(added).toEqual({ level: "accountant", name: "Accountant" });
    expect((await admin.post("/api/access-levels/expenses", { name: "accountant" })).status).toBe(409);
    expect((await admin.post("/api/access-levels/expenses", { name: "Manager" })).status).toBe(409);
    await admin.put("/api/access-levels/expenses/accountant", { permissions: { [claims]: { view: true, edit: true } } }).expect(200);
    expect((await app("expenses")).levels.find((l) => l.level === "accountant")!.permissions[claims]).toMatchObject({ view: true, edit: true, create: false });
    // a table of another app can't be given here
    expect((await admin.put("/api/access-levels/expenses/accountant", { permissions: { [orders]: { view: true } } })).status).toBe(400);
    // the level shows in App access, by its name
    const options = (await admin.get("/api/users/app-access")).body as { key: string; levels: { level: string; label: string }[]; managerNote?: string }[];
    const e = options.find((o) => o.key === "expenses")!;
    expect(e.levels.map((l) => l.label)).toEqual(["Staff", "Accountant", "Manager"]);
    expect(e.managerNote).toMatch(/expense claims/);
    await admin.del("/api/access-levels/expenses/accountant").expect(200);
    expect((await admin.del("/api/access-levels/expenses/staff")).status).toBe(400);
  });

  it("resets Staff back to what the app came with", async () => {
    const before = (await app("expenses")).levels.find((l) => l.level === "staff")!.permissions;
    await admin.put("/api/access-levels/expenses/staff", { permissions: {} }).expect(200);
    expect((await app("expenses")).levels.find((l) => l.level === "staff")!.permissions).toEqual({});
    await admin.post("/api/access-levels/expenses/staff/reset").expect(200);
    expect((await app("expenses")).levels.find((l) => l.level === "staff")!.permissions).toEqual(before);
    expect((await admin.post(`/api/access-levels/my-tables/staff/reset`)).status).toBe(200); // nothing to reset: unchanged
  });

  it("lists older roles still to move", async () => {
    const older = (await levels()).olderRoles.map((r) => r.name);
    expect(older).toEqual(expect.arrayContaining([salesRep.name, ops.name, approver.name]));
  });

  let before: Record<string, unknown>[];
  it("the preview says what happens, and changes nothing", async () => {
    before = await Promise.all(everyone.map(rights));
    const peek = await admin.post("/api/access-levels/move", { apply: false });
    const res = peek.body;
    expect(res.moved).toBe(false);
    const sales = res.roles.find((r: { name: string }) => r.name === salesRep.name);
    expect(sales.becomes).toEqual(expect.arrayContaining([`My tables · ${salesRep.name}`]));
    expect((await levels()).olderRoles.map((r) => r.name)).toContain(salesRep.name); // still there
  });

  it("refuses a move that would change what anyone can do", async () => {
    // a role with no rights that only opens Ask Zenin can't become a level
    const ghost = await role("Ghost", {});
    const ghostPerson = await person(ghost._id);
    await admin.put("/api/ai", { askRoles: [ghost._id] }).expect(200);
    const res = await admin.post("/api/access-levels/move", { apply: true });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/would change what .* can do.*Nothing was changed/);
    expect((await levels()).olderRoles.map((r) => r.name)).toContain(salesRep.name);
    await admin.put("/api/ai", { askRoles: [] }).expect(200);
    await admin.put(`/api/users/${ghostPerson.id}`, { roleId: memberId }).expect(200);
    await admin.del(`/api/roles/${ghost._id}`).expect(200);
  });

  it("moves older roles to levels, and everyone can do exactly what they could", async () => {
    await admin.put("/api/ai", { askRoles: [salesRep._id] }).expect(200);
    const res = (await admin.post("/api/access-levels/move", { apply: true }).expect(200)).body;
    expect(res.moved).toBe(true);
    expect((await levels()).olderRoles).toEqual([]);
    // rights per table, for every person
    expect(await Promise.all(everyone.map(rights))).toEqual(before);

    const all = await roles();
    const levelOf = (userRoles: string[], app: string) => all.filter((r) => userRoles.includes(r._id) && r.appKey === app).map((r) => r.name);
    const userRoles = async (id: string) => ((await admin.get("/api/users")).body as { _id: string; role: { _id: string }; appAccess: Record<string, string> }[]).find((u) => u._id === id)!;
    // the sales rep is a Member now, with a level of the same name
    const r1 = await userRoles(rep.id);
    expect(r1.role._id).toBe(memberId);
    expect(Object.keys(r1.appAccess)).toEqual(expect.arrayContaining(["my-tables", "expenses"]));
    // Staff in Expenses plus Ops: both kept, in one level per app
    const r2 = await userRoles(opsStaff.id);
    expect(r2.appAccess.expenses).toBe("staff"); // Ops had nothing in Expenses
    // a Manager of Expenses stays its Manager (reminders still reach them)
    expect((await userRoles(repManager.id)).appAccess.expenses).toBe("manager");
    void levelOf;

    // what they can really do
    const id = (await rep.client.post(`/api/table/${orders}`, { title: "x", status: "New" }).expect(200)).body.data.insertedId;
    expect((await opsStaff.client.post(`/api/table/${orders}`, { title: "y" })).status).toBe(403); // edit-only stayed edit-only
    await opsStaff.client.put(`/api/table/${orders}/${id}`, { title: "x2" }).expect(200);
    expect((await rep.client.put(`/api/table/${orders}/${id}`, { status: "Approved" })).status).toBe(400); // only the approver
    expect((await approverPerson.client.get(`/api/table/${orders}`)).status).toBe(404); // the approver still can't open it
    // Ask Zenin stays open to the sales rep's level
    expect((await rep.client.get("/api/ai/assistant")).body).toBeDefined();
    const ai = (await admin.get("/api/ai")).body as { askRoles: string[] };
    expect(ai.askRoles.length).toBeGreaterThan(0);
    expect(ai.askRoles).not.toContain(salesRep._id);
    await admin.put("/api/ai", { askRoles: [] }).expect(200);
  });

  it("moving again does nothing", async () => {
    const res = (await admin.post("/api/access-levels/move", { apply: true }).expect(200)).body;
    expect(res).toMatchObject({ moved: false, roles: [], levels: [] });
  });

  it("only admins can see or change levels", async () => {
    expect((await plain.client.get("/api/access-levels")).status).toBe(403);
    expect((await plain.client.post("/api/access-levels/move", { apply: false })).status).toBe(403);
  });
});
