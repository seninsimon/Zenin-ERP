import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// The Spreadsheet view (workspace/SPREADSHEET_PLAN.md): a switch per table,
// rows with their stored values, and each cell's "changed meanwhile" check.
describe("Spreadsheet view", async () => {
  const admin = await login();
  const memberId = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!._id;
  const app = (await admin.post("/api/apps/own", { name: unique("Stock"), icon: "IconPackage" }).expect(201)).body as { key: string };
  const places = unique("places");
  await admin.post("/api/schema", { tableName: places, byDepartment: false, app: app.key, staff: "view", columns: [{ name: "name", label: "Name" }] }).expect(200);
  const items = unique("items");
  await admin.post("/api/schema", {
    tableName: items,
    byDepartment: false,
    app: app.key,
    staff: "work",
    columns: [
      { name: "name", label: "Name" },
      { name: "qty", label: "Qty", type: "number" },
      { name: "cost", label: "Cost", type: "number", onlyLevels: ["manager"] },
      { name: "place", label: "Place", type: "relation", ref: places },
      { name: "note", label: "Note" },
    ],
  }).expect(200);
  const person = async (level: string) => {
    const username = unique(level).toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: level } }).expect(201);
    return login(username, "pass-123-pass");
  };
  const asha = await person("staff");
  const ravi = await person("staff");
  const shelf = (await admin.post(`/api/table/${places}`, { name: "Shelf A" }).expect(200)).body.data.insertedId;
  const id = (await admin.post(`/api/table/${items}`, { name: "Bolts", qty: 4, cost: 9, place: shelf }).expect(200)).body.data.insertedId;

  it("is off until an admin switches it on for a table", async () => {
    expect((await asha.get(`/api/schema/${items}`)).body.spreadsheet).toBe(false);
    await admin.put(`/api/schema/${items}`, { spreadsheet: true }).expect(200);
    expect((await asha.get(`/api/schema/${items}`)).body.spreadsheet).toBe(true);
    expect((await asha.put(`/api/schema/${items}`, { spreadsheet: false })).status).toBe(403);
  });

  it("rows can come with their stored values, hidden fields left out", async () => {
    const row = (await asha.get(`/api/table/${items}?withRaw=1`).expect(200)).body.data[0];
    expect(row.place).toBe("Shelf A"); // the name, to show
    expect(row._raw).toEqual({ name: "Bolts", qty: 4, place: shelf, note: null }); // the id, to edit; no cost
    expect((await asha.get(`/api/table/${items}`)).body.data[0]._raw).toBeUndefined();
  });

  it("a cell saves when it hasn't changed meanwhile", async () => {
    await asha.put(`/api/table/${items}/${id}`, { qty: 5, _expected: { qty: 4 } }).expect(200);
    // empty is empty: "" and a missing value are the same
    await asha.put(`/api/table/${items}/${id}`, { note: "top shelf", _expected: { note: "" } }).expect(200);
  });

  it("two people on one cell: the second is told, and nothing is overwritten", async () => {
    // both started from 5; Ravi saves first
    await ravi.put(`/api/table/${items}/${id}`, { qty: 7, _expected: { qty: 5 } }).expect(200);
    const res = await asha.put(`/api/table/${items}/${id}`, { qty: 6, _expected: { qty: 5 } });
    expect(res.status).toBe(409);
    expect(res.body.errors).toMatchObject({ _cellConflict: "qty", qty: expect.stringMatching(/changed this a moment ago/) });
    expect(res.body.message).toMatch(/changed Qty a moment ago/);
    expect((await admin.get(`/api/table/${items}/${id}`)).body.qty).toBe(7);
    // "Use mine": saved from the value she now sees
    await asha.put(`/api/table/${items}/${id}`, { qty: 6, _expected: { qty: 7 } }).expect(200);
    // other cells of the same record don't clash
    await ravi.put(`/api/table/${items}/${id}`, { name: "Bolts M6", _expected: { name: "Bolts" } }).expect(200);
  });

  it("can't be used to guess a hidden field", async () => {
    expect((await asha.put(`/api/table/${items}/${id}`, { qty: 1, _expected: { cost: 9 } })).status).toBe(403);
  });
});
