import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Every table belongs to an app: "My tables", or an app you make (workspace/
// ACCESS_PLAN.md part 3). Each has a Manager (everything) and a Staff role.
describe("Apps you make, and every table in an app", async () => {
  const admin = await login();
  type Home = { key: string; name: string; icon: string; own: boolean };
  const homes = async () => (await admin.get("/api/apps/homes").expect(200)).body as Home[];
  const roleOf = async (appKey: string, level: string) =>
    ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null; appLevel: string | null; permissions: Record<string, Record<string, boolean>> }[]).find(
      (r) => r.appKey === appKey && r.appLevel === level
    )!;
  const person = async (appAccess: Record<string, string>) => {
    const username = unique("p").toLowerCase();
    const member = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!;
    await admin.post("/api/users", { username, password: "pass-123-pass", appAccess, roleId: member._id }).expect(201);
    return login(username, "pass-123-pass");
  };
  const name = `Sales desk ${unique("x").slice(-6)}`;
  let app: { key: string; name: string; icon: string };

  it("New app: a name and an icon, with its own Manager and Staff", async () => {
    app = (await admin.post("/api/apps/own", { name, icon: "IconTruck" }).expect(201)).body;
    expect(app).toMatchObject({ name, icon: "IconTruck" });
    expect(app.key).toMatch(/^custom-sales-desk-/);
    expect((await homes()).map((h) => h.key)).toEqual(expect.arrayContaining(["my-tables", app.key]));
    expect((await homes())[0].key).toBe("my-tables"); // first
    expect((await roleOf(app.key, "manager")).name).toBe(`${name} · Manager`);
    expect((await roleOf(app.key, "staff")).name).toBe(`${name} · Staff`);
    // it can be given to people like any app
    const options = (await admin.get("/api/users/app-access")).body as { key: string; name: string }[];
    expect(options).toEqual(expect.arrayContaining([expect.objectContaining({ key: app.key, name })]));
  });

  it("checks the name", async () => {
    expect((await admin.post("/api/apps/own", { name: "  " })).status).toBe(400);
    expect((await admin.post("/api/apps/own", { name: "A · B" })).status).toBe(400);
    expect((await admin.post("/api/apps/own", { name: name.toUpperCase() })).status).toBe(409);
    expect((await admin.post("/api/apps/own", { name: "Projects" })).status).toBe(409); // a catalog app's name
    const odd = (await admin.post("/api/apps/own", { name: unique("Odd icon"), icon: "IconNope" }).expect(201)).body;
    expect(odd.icon).toBe("IconApps");
    await admin.del(`/api/apps/${odd.key}`).expect(200);
  });

  let orders: string;
  it("Add table puts it in an app: Managers get everything, Staff what was chosen", async () => {
    orders = unique("orders");
    const res = await admin.post("/api/schema", { tableName: orders, columns: [{ name: "title", label: "Title" }], byDepartment: false, app: app.key, staff: "work" }).expect(200);
    expect(res.body.data.appKey).toBe(app.key);
    expect((await admin.get(`/api/schema/${orders}`)).body.app).toMatchObject({ key: app.key, name });
    expect((await roleOf(app.key, "manager")).permissions[orders]).toEqual({ view: true, create: true, edit: true, delete: true });
    expect((await roleOf(app.key, "staff")).permissions[orders]).toEqual({ view: true, create: true, edit: true, delete: false });

    // and that's what people with App access really get
    const staff = await person({ [app.key]: "staff" });
    const id = (await staff.post(`/api/table/${orders}`, { title: "First" }).expect(200)).body.data.insertedId;
    expect((await staff.del(`/api/table/${orders}/${id}`)).status).toBe(403);
    const manager = await person({ [app.key]: "manager" });
    await manager.del(`/api/table/${orders}/${id}`).expect(200);
  });

  it("without an app it goes to My tables, with no Staff access unless chosen", async () => {
    const t = unique("notes");
    await admin.post("/api/schema", { tableName: t, columns: [{ name: "title", label: "Title" }], byDepartment: false }).expect(200);
    expect((await admin.get(`/api/schema/${t}`)).body.app).toMatchObject({ key: "my-tables" });
    expect((await roleOf("my-tables", "manager")).permissions[t]).toMatchObject({ delete: true });
    expect((await roleOf("my-tables", "staff")).permissions[t]).toBeUndefined();
    const v = unique("view");
    await admin.post("/api/schema", { tableName: v, columns: [{ name: "title", label: "Title" }], app: "my-tables", staff: "view" }).expect(200);
    expect((await roleOf("my-tables", "staff")).permissions[v]).toEqual({ view: true, create: false, edit: false, delete: false });
  });

  it("refuses an unknown app or Staff choice, before making anything", async () => {
    const t = unique("nope");
    expect((await admin.post("/api/schema", { tableName: t, columns: [], app: "custom-missing" })).status).toBe(400);
    expect((await admin.post("/api/schema", { tableName: t, columns: [], staff: "everything" })).status).toBe(400);
    expect((await admin.get(`/api/schema/${t}`)).status).toBe(404);
  });

  it("moves a table you made; it takes its Staff rights along", async () => {
    await admin.put(`/api/schema/${orders}/app`, { app: "my-tables" }).expect(200);
    expect((await admin.get(`/api/schema/${orders}`)).body.app).toMatchObject({ key: "my-tables" });
    expect((await roleOf(app.key, "staff")).permissions[orders]).toBeUndefined();
    expect((await roleOf(app.key, "manager")).permissions[orders]).toBeUndefined();
    expect((await roleOf("my-tables", "staff")).permissions[orders]).toEqual({ view: true, create: true, edit: true, delete: false });
    expect((await roleOf("my-tables", "manager")).permissions[orders]).toMatchObject({ delete: true });
    await admin.put(`/api/schema/${orders}/app`, { app: app.key }).expect(200);
    expect((await roleOf(app.key, "staff")).permissions[orders]).toMatchObject({ create: true });
    expect((await admin.put(`/api/schema/${orders}/app`, { app: "custom-missing" })).status).toBe(400);
  });

  it("tables that came with an app stay in it", async () => {
    await admin.post("/api/apps/install", { apps: ["expenses"] }).expect(200);
    const claims = ((await admin.get("/api/schema")).body as { tableName: string; blueprintKey: string | null }[]).find((t) => t.blueprintKey?.startsWith("expenses."))!;
    const res = await admin.put(`/api/schema/${claims.tableName}/app`, { app: "my-tables" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/came with/);
    // installed apps that show as themselves can take new tables; Company's parts can't
    const keys = (await homes()).map((h) => h.key);
    expect(keys).toContain("expenses");
    expect(keys).not.toContain("people");
  });

  it("renames an app you made, and its roles", async () => {
    const renamed = `${name} 2`;
    await admin.put(`/api/apps/${app.key}`, { name: renamed, icon: "IconCash" }).expect(200);
    expect((await admin.get(`/api/schema/${orders}`)).body.app).toMatchObject({ name: renamed, icon: "IconCash" });
    expect((await roleOf(app.key, "manager")).name).toBe(`${renamed} · Manager`);
    expect((await admin.put("/api/apps/expenses", { name: "Mine now" })).status).toBe(404); // not yours to rename
    await admin.put("/api/apps/my-tables", { name: "Office tables" }).expect(200);
    expect((await roleOf("my-tables", "staff")).name).toBe("Office tables · Staff");
    await admin.put("/api/apps/my-tables", { name: "My tables" }).expect(200);
  });

  it("removing an app you made keeps its tables and records, in My tables", async () => {
    const staff = await person({ [app.key]: "staff" });
    await staff.post(`/api/table/${orders}`, { title: "Kept" }).expect(200);
    await admin.del(`/api/apps/${app.key}`).expect(200);
    expect((await admin.get(`/api/schema/${orders}`)).body.app).toMatchObject({ key: "my-tables" });
    expect((await admin.get(`/api/table/${orders}`)).body.data.map((r: { title: string }) => r.title)).toEqual(["Kept"]);
    expect((await roleOf("my-tables", "manager")).permissions[orders]).toMatchObject({ delete: true });
    expect(await roleOf(app.key, "staff")).toBeUndefined();
    expect((await homes()).map((h) => h.key)).not.toContain(app.key);
    expect((await admin.del("/api/apps/my-tables")).status).toBe(409);
  });
});
