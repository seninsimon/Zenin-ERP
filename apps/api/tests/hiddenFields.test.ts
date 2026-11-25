import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { recordDetails } from "../src/mail/render.js";
import { getSchema } from "../src/schema/schemaRepo.js";
import { login, unique } from "./helpers.js";

// Fields some levels don't see (workspace/ACCESS_PLAN.md part 6): Salary is
// for Managers. Every way a value can leave the server is tried as Staff.
describe("Fields only some levels see", async () => {
  const admin = await login();
  const memberId = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!._id;
  const app = (await admin.post("/api/apps/own", { name: unique("Pay"), icon: "IconCash" }).expect(201)).body as { key: string };

  const teams = unique("teams");
  await admin.post("/api/schema", { tableName: teams, byDepartment: false, app: app.key, staff: "view", columns: [{ name: "name", label: "Name" }] }).expect(200);
  const pay = unique("pay");
  await admin.post("/api/schema", {
    tableName: pay,
    byDepartment: false,
    app: app.key,
    staff: "work",
    columns: [
      { name: "name", label: "Name", required: true },
      { name: "salary", label: "Salary", type: "number", required: true },
      { name: "bonus", label: "Bonus", type: "number" },
      { name: "net", label: "Net", type: "formula", formula: { expression: "{salary} + {bonus}" } },
      { name: "team", label: "Team", type: "relation", ref: teams },
      { name: "note", label: "Note" },
    ],
  }).expect(200);
  await admin.post(`/api/schema/${teams}/column`, { name: "total", label: "Total salary", type: "rollup", rollup: { from: pay, via: "team", fn: "sum", field: "salary" } }).expect(200);

  const person = async (level: string) => {
    const username = unique(level).toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: level } }).expect(201);
    return login(username, "pass-123-pass");
  };
  const staff = await person("staff");
  const manager = await person("manager");

  const teamId = (await admin.post(`/api/table/${teams}`, { name: "Ops" }).expect(200)).body.data.insertedId;
  let recordId: string;

  it("is set on a column, but never on the field that names records", async () => {
    await admin.put(`/api/schema/${pay}/column/salary`, { onlyLevels: ["manager"] }).expect(200);
    const res = await admin.put(`/api/schema/${pay}/column/name`, { onlyLevels: ["manager"] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/names each record/);
    recordId = (await manager.post(`/api/table/${pay}`, { name: "Asha", salary: 98765, bonus: 100, team: teamId, note: "fine" }).expect(200)).body.data.insertedId;
  });

  const names = (cols: { name: string }[]) => cols.map((c) => c.name);

  it("isn't described to Staff; values worked out from it are hidden too", async () => {
    expect(names((await staff.get(`/api/schema/${pay}`)).body.columns)).toEqual(["name", "bonus", "team", "note"]);
    expect(names((await manager.get(`/api/schema/${pay}`)).body.columns)).toEqual(expect.arrayContaining(["salary", "net"]));
    // the total over salaries, in another table
    expect(names((await staff.get(`/api/schema/${teams}`)).body.columns)).not.toContain("total");
  });

  it("lists, the record and the raw list leave it out", async () => {
    const row = (await staff.get(`/api/table/${pay}`).expect(200)).body.data[0];
    expect(row).toMatchObject({ name: "Asha", bonus: 100 });
    expect(row).not.toHaveProperty("salary");
    expect(row).not.toHaveProperty("net");
    expect((await manager.get(`/api/table/${pay}`)).body.data[0]).toMatchObject({ salary: 98765, net: 98865 });
    const one = (await staff.get(`/api/table/${pay}/${recordId}`).expect(200)).body;
    expect(one).not.toHaveProperty("salary");
    expect(one).not.toHaveProperty("net");
    const raw = (await staff.get(`/api/table/${pay}?raw=1`).expect(200)).body.data[0];
    expect(raw).not.toHaveProperty("salary");
    const team = (await staff.get(`/api/table/${teams}`).expect(200)).body.data[0];
    expect(team).not.toHaveProperty("total");
    expect((await manager.get(`/api/table/${teams}`)).body.data[0].total).toBe(98765);
  });

  it("can't be found by searching, filtering or sorting", async () => {
    expect((await staff.get(`/api/table/${pay}?search=98765`)).body.total).toBe(0);
    expect((await manager.get(`/api/table/${pay}?search=98765`)).body.total).toBe(1);
    expect((await staff.get(`/api/table/${pay}?search=Asha`)).body.total).toBe(1); // other fields still searchable
    const filters = encodeURIComponent(JSON.stringify([{ field: "salary", op: "gt", value: 1000 }]));
    expect((await staff.get(`/api/table/${pay}?filters=${filters}`)).status).toBe(400);
    expect((await staff.get(`/api/table/${pay}?sort=salary`)).status).toBe(400);
    const net = encodeURIComponent(JSON.stringify([{ field: "net", op: "gt", value: 1 }]));
    expect((await staff.get(`/api/table/${pay}?filters=${net}`)).status).toBe(400);
    expect((await manager.get(`/api/table/${pay}?filters=${filters}`)).body.total).toBe(1);
  });

  it("can't be written; and its being required doesn't stop Staff", async () => {
    expect((await staff.post(`/api/table/${pay}`, { name: "Ravi", salary: 1 })).status).toBe(403);
    await staff.post(`/api/table/${pay}`, { name: "Ravi" }).expect(200); // Salary is required, but not theirs to fill
    expect((await staff.put(`/api/table/${pay}/${recordId}`, { salary: 1 })).status).toBe(403);
    await staff.put(`/api/table/${pay}/${recordId}`, { note: "ok" }).expect(200);
    expect((await staff.post(`/api/table/${pay}/bulk-update`, { ids: [recordId], field: "salary", value: 1 })).status).toBe(403);
    expect((await manager.get(`/api/table/${pay}/${recordId}`)).body.salary).toBe(98765); // unchanged
  });

  it("isn't in the record's history for Staff", async () => {
    await manager.put(`/api/table/${pay}/${recordId}`, { salary: 99000 }).expect(200);
    const history = (await staff.get(`/api/audit?tableName=${pay}&recordId=${recordId}`).expect(200)).body.data as { changes: Record<string, unknown> }[];
    expect(history.length).toBeGreaterThan(0);
    for (const e of history) {
      expect(e.changes).not.toHaveProperty("salary");
      expect(e.changes).not.toHaveProperty("net");
    }
    const mine = (await manager.get(`/api/audit?tableName=${pay}&recordId=${recordId}`)).body.data as { changes: Record<string, unknown> }[];
    expect(mine.some((e) => "salary" in e.changes)).toBe(true);
  });

  it("isn't exported, and can't be imported", async () => {
    const start = (await staff.post(`/api/table/${pay}/export`).expect(202)).body.job;
    await drainJobs();
    const file = await staff.get(`/api/jobs/${start._id}/download`);
    const text = file.text.replace(/^﻿/, "");
    expect(text.split(/\r?\n/)[0]).not.toMatch(/Salary|Net/);
    expect(text).not.toMatch(/99000|99100/);
    const filters = [{ field: "salary", op: "gt", value: 1 }];
    expect((await staff.post(`/api/table/${pay}/export`, { filters })).status).toBe(400);

    const csv = Buffer.from("Name,Salary\nNew one,5\n", "utf8");
    const imp = (await staff.upload(`/api/table/${pay}/import`).attach("file", csv, "pay.csv").expect(202)).body.job;
    await drainJobs();
    const job = (await staff.get(`/api/jobs/${imp._id}`)).body;
    expect(job).toMatchObject({ status: "failed", error: expect.stringMatching(/can.t import into "Salary"/) });
    expect((await manager.get(`/api/table/${pay}?search=New%20one`)).body.total).toBe(0);
  });

  it("never goes in emails, and never names a record", async () => {
    const schema = (await getSchema(pay))!;
    const details = await recordDetails(schema, { name: "Asha", salary: 99000, bonus: 100, net: 99100, note: "x" });
    expect(details.map((d) => d.label)).not.toEqual(expect.arrayContaining(["Salary"]));
    expect(details.map((d) => d.label)).not.toEqual(expect.arrayContaining(["Net"]));
    // a link to this table shows the name, whatever is asked for
    const options = (await staff.get(`/api/table/${pay}/options?displayField=salary`)).body as { label: string }[];
    expect(options.map((o) => o.label)).toEqual(expect.arrayContaining(["Asha"]));
    expect(JSON.stringify(options)).not.toMatch(/99000/);
  });

  it("admins and Managers see everything; taking the limit off shows it again", async () => {
    expect((await admin.get(`/api/table/${pay}/${recordId}`)).body.salary).toBe(99000);
    await admin.put(`/api/schema/${pay}/column/salary`, { onlyLevels: [] }).expect(200);
    expect((await staff.get(`/api/table/${pay}/${recordId}`)).body.salary).toBe(99000);
  });
});
