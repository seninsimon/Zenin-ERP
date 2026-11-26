import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { query } from "../src/db/pool.js";
import { login, unique } from "./helpers.js";

// Locked records (workspace/RECORD_LOCK_PLAN.md): a status option ("Paid")
// that locks the record against every kind of change until a Manager reopens it.
describe("Locked records", async () => {
  const admin = await login();
  const memberId = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!._id;
  const app = (await admin.post("/api/apps/own", { name: unique("Sales"), icon: "IconReceipt" }).expect(201)).body as { key: string };
  const invoices = unique("invoices");
  const lines = unique("inv_lines");
  const payments = unique("payments");
  await admin
    .post("/api/schema", {
      tableName: invoices,
      byDepartment: false,
      app: app.key,
      staff: "work",
      columns: [
        { name: "title", label: "Title", required: true },
        { name: "note", label: "Note" },
        { name: "status", label: "Status", type: "choice", default: "Draft", options: [{ label: "Draft" }, { label: "Sent" }, { label: "Paid", locks: true }] },
      ],
    })
    .expect(200);
  for (const [name, columns] of [
    [lines, [{ name: "invoice", label: "Invoice", type: "relation", ref: invoices, inline: true, required: true }, { name: "item", label: "Item" }]],
    [payments, [{ name: "invoice", label: "Invoice", type: "relation", ref: invoices }, { name: "amount", label: "Amount", type: "number" }]],
  ] as const) {
    await admin.post("/api/schema", { tableName: name, byDepartment: false, app: app.key, staff: "work", columns }).expect(200);
  }
  await admin.post(`/api/schema/${invoices}/column`, { name: "paid", label: "Paid so far", type: "rollup", rollup: { from: payments, via: "invoice", fn: "sum", field: "amount" } }).expect(200);

  const person = async (level: string) => {
    const username = unique(level).toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: level } }).expect(201);
    return login(username, "pass-123-pass");
  };
  const staff = await person("staff");
  const manager = await person("manager");
  const make = async (title: string) => {
    const id = (await staff.post(`/api/table/${invoices}`, { title, _children: { [lines]: { create: [{ item: "Work" }] } } }).expect(200)).body.data.insertedId as string;
    const all = (await admin.get(`/api/table/${lines}?withRaw=1&limit=500`)).body.data as { _id: string; _raw: { invoice: string } }[];
    const line = all.find((l) => l._raw.invoice === id)!._id;
    return { id, line };
  };
  const get = async (id: string) => (await admin.get(`/api/table/${invoices}/${id}`)).body;

  it("keeps the lock tick on the option", async () => {
    const status = (await admin.get(`/api/schema/${invoices}`)).body.columns.find((c: { name: string }) => c.name === "status");
    expect(status.options.map((o: { label: string; locks?: boolean }) => [o.label, Boolean(o.locks)])).toEqual([["Draft", false], ["Sent", false], ["Paid", true]]);
  });

  it("a record at a locking status can't be changed, by any route", async () => {
    const { id, line } = await make("INV A");
    await staff.put(`/api/table/${invoices}/${id}`, { status: "Paid" }).expect(200); // setting it is fine
    expect((await get(id))._locked).toMatchObject({ status: "Paid", label: "Status", canReopen: true, reopenTo: ["Draft", "Sent"] }); // admin's view

    const edit = await staff.put(`/api/table/${invoices}/${id}`, { note: "changed" });
    expect(edit.status).toBe(409);
    expect(edit.body.message).toMatch(/Locked: Status is Paid/);
    expect((await staff.put(`/api/table/${invoices}/${id}`, { status: "Draft" })).status).toBe(409); // not even the status
    expect((await admin.put(`/api/table/${invoices}/${id}`, { note: "admin too" })).status).toBe(409); // admins reopen, they don't edit through
    expect((await staff.put(`/api/table/${invoices}/${id}`, { note: "x", _expected: { note: null } })).status).toBe(409); // the Spreadsheet's save
    expect((await admin.del(`/api/table/${invoices}/${id}`)).status).toBe(409);
    expect((await get(id)).title).toBe("INV A"); // still there

    // "Change a field": skipped and said why
    const bulk = (await admin.post(`/api/table/${invoices}/bulk-update`, { ids: [id], field: "note", value: "bulk" }).expect(200)).body;
    expect(bulk.updated).toBe(0);
    expect(bulk.skipped[0].message).toMatch(/Locked/);
    // "Delete rows": nothing deleted
    const { id: other } = await make("INV B");
    const bulkDel = await admin.post(`/api/table/${invoices}/bulk-delete`, { ids: [other, id] });
    expect(bulkDel.status).toBe(409);
    expect(bulkDel.body.message).toMatch(/Nothing was deleted: "INV A" is locked/);
    expect((await get(other)).title).toBe("INV B");

    // its lines are locked with it: edit, delete, add, or through the invoice
    expect((await staff.put(`/api/table/${lines}/${line}`, { item: "More" })).status).toBe(409);
    expect((await admin.del(`/api/table/${lines}/${line}`)).status).toBe(409);
    expect((await staff.post(`/api/table/${lines}`, { invoice: id, item: "Extra" })).status).toBe(409);
    expect((await admin.get(`/api/table/${lines}/${line}`)).body._locked).toMatchObject({ status: "Paid", parent: { table: invoices, id }, canReopen: false });

    // what the server works out still updates: a payment recorded later
    await staff.post(`/api/table/${payments}`, { invoice: id, amount: 500 }).expect(200);
    expect((await get(id)).paid).toBe(500);
    // lists mark it, for the Spreadsheet
    const listed = (await admin.get(`/api/table/${invoices}?withRaw=1&limit=100`)).body.data.find((r: { _id: string }) => r._id === id);
    expect(listed._locked).toBe("Paid");
  });

  it("an import can't change it either", async () => {
    const { id } = await make("INV C");
    await staff.put(`/api/table/${invoices}/${id}`, { status: "Paid" }).expect(200);
    const start = await admin.upload(`/api/table/${invoices}/import`).attach("file", Buffer.from(`ID,Title\n${id},Renamed`), "f.csv");
    expect(start.status).toBe(202);
    await drainJobs();
    const job = (await admin.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job.result?.failed ?? job.failed).toBe(1);
    expect((await get(id)).title).toBe("INV C");
  });

  it("a manager reopens it, with a reason, and then it can change", async () => {
    const { id } = await make("INV D");
    await staff.put(`/api/table/${invoices}/${id}`, { status: "Paid" }).expect(200);
    // staff can't reopen
    expect((await staff.post(`/api/table/${invoices}/${id}/reopen`, { reason: "oops", to: "Sent" })).status).toBe(403);
    expect((await staff.get(`/api/table/${invoices}/${id}`)).body._locked.canReopen).toBe(false);
    // a reason and a non-locking status are needed
    expect((await manager.post(`/api/table/${invoices}/${id}/reopen`, { to: "Sent" })).status).toBe(400);
    expect((await manager.post(`/api/table/${invoices}/${id}/reopen`, { reason: "wrong amount", to: "Paid" })).status).toBe(400);
    await manager.post(`/api/table/${invoices}/${id}/reopen`, { reason: "wrong amount", to: "Sent" }).expect(200);
    expect((await get(id))._locked).toBeNull();
    expect((await get(id)).status).toBe("Sent");
    await staff.put(`/api/table/${invoices}/${id}`, { note: "fixed" }).expect(200);
    // in the audit log, with the reason
    const { rows } = await query<{ changes: Record<string, unknown> }>(`SELECT changes FROM audit_log WHERE action = 'reopen' AND record_id = $1`, [id]);
    expect(rows[0].changes).toMatchObject({ _reason: { to: "wrong amount" }, status: { from: "Paid", to: "Sent" } });
    // reopening something that isn't locked
    expect((await manager.post(`/api/table/${invoices}/${id}/reopen`, { reason: "x", to: "Draft" })).status).toBe(400);
  });

  it("ready-made apps come with their locks", async () => {
    const installed = (await admin.get("/api/apps")).body.apps.find((a: { key: string; installed: unknown }) => a.key === "hr")?.installed;
    if (!installed) await admin.post("/api/apps/install", { apps: ["hr"] }).expect(200);
    const leave = (await admin.get("/api/schema/leave_requests")).body.columns.find((c: { name: string }) => c.name === "status");
    expect(leave.options.filter((o: { locks?: boolean }) => o.locks).map((o: { label: string }) => o.label)).toEqual(["Approved", "Rejected"]);
    if (!installed) {
      await admin.del("/api/apps/hr").expect(200);
      await admin.del("/api/apps/people").expect(200);
    }
  });
});
