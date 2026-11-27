import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

type Board = { app: string; launcher: string; reports: { id: string; name: string; table: string; groupBy: string; show: string; chart: string | null; problem?: string }[] };

// Reports (docs/WORKFLOW.md): saved summaries in their app's
// block on Home. Admins pin them; apps bring ready-made ones.
describe("Reports on Home", async () => {
  const admin = await login();
  const memberId = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!._id;
  const app = (await admin.post("/api/apps/own", { name: unique("Sales"), icon: "IconCash" }).expect(201)).body as { key: string };
  const deals = unique("deals");
  await admin
    .post("/api/schema", {
      tableName: deals,
      byDepartment: false,
      app: app.key,
      staff: "view",
      columns: [
        { name: "title", label: "Title" },
        { name: "stage", label: "Stage", type: "choice", options: [{ label: "Lead" }, { label: "Won" }] },
        { name: "amount", label: "Amount", type: "number" },
        { name: "margin", label: "Margin", type: "number", onlyLevels: ["manager"] },
      ],
    })
    .expect(200);
  const username = unique("rep").toLowerCase();
  await admin.post("/api/users", { username, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: "staff" } }).expect(201);
  const rep = await login(username, "pass-123-pass");
  const reportsOf = async (client: typeof admin) => ((await client.get("/api/apps/dashboards").expect(200)).body as Board[]).flatMap((b) => b.reports.map((r) => ({ ...r, launcher: b.launcher })));

  it("an admin pins a summary; it shows in its app's block for everyone who can see the table", async () => {
    const res = await admin.post("/api/reports", { name: "Amount by stage", table: deals, groupBy: "stage", show: "sum:amount", chart: "donut" }).expect(201);
    const mine = (await reportsOf(rep)).find((r) => r.id === res.body.id);
    expect(mine).toMatchObject({ name: "Amount by stage", table: deals, groupBy: "stage", show: "sum:amount", chart: "donut", launcher: app.key });
    // only admins pin, rename or remove
    expect((await rep.post("/api/reports", { name: "x", table: deals, groupBy: "stage" })).status).toBe(403);
    expect((await rep.put(`/api/reports/${res.body.id}`, { name: "x" })).status).toBe(403);
    expect((await rep.del(`/api/reports/${res.body.id}`)).status).toBe(403);
  });

  it("refuses what can't be summarised, and hides reports on fields a person can't see", async () => {
    expect((await admin.post("/api/reports", { name: "x", table: deals, groupBy: "title" })).status).toBe(400);
    expect((await admin.post("/api/reports", { name: "x", table: deals, groupBy: "stage", show: "sum:title" })).status).toBe(400);
    expect((await admin.post("/api/reports", { name: "", table: deals, groupBy: "stage" })).status).toBe(400);
    const margin = (await admin.post("/api/reports", { name: "Margin by stage", table: deals, groupBy: "stage", show: "sum:margin" }).expect(201)).body.id;
    expect((await reportsOf(admin)).some((r) => r.id === margin)).toBe(true);
    expect((await reportsOf(rep)).some((r) => r.id === margin)).toBe(false);
  });

  it("renames, removes; a removed column shows admins the problem", async () => {
    const id = (await admin.post("/api/reports", { name: "By stage", table: deals, groupBy: "stage" }).expect(201)).body.id;
    await admin.put(`/api/reports/${id}`, { name: "Deals by stage" }).expect(200);
    expect((await reportsOf(admin)).find((r) => r.id === id)?.name).toBe("Deals by stage");
    await admin.del(`/api/schema/${deals}/column/stage`).expect(200);
    expect((await reportsOf(admin)).find((r) => r.id === id)?.problem).toMatch(/groups by was removed/);
    expect((await reportsOf(rep)).some((r) => r.id === id)).toBe(false);
    await admin.del(`/api/reports/${id}`).expect(200);
    expect((await reportsOf(admin)).some((r) => r.id === id)).toBe(false);
  });

  it("go with their table", async () => {
    await admin.del(`/api/schema/${deals}`).expect(200);
    expect((await reportsOf(admin)).some((r) => r.table === deals)).toBe(false);
  });

  it("apps bring ready-made ones, removed with the app", async () => {
    const had = (await admin.get("/api/apps")).body.apps.find((a: { key: string; installed: unknown }) => a.key === "expenses")?.installed;
    if (!had) await admin.post("/api/apps/install", { apps: ["expenses"] }).expect(200);
    const ready = (await reportsOf(admin)).find((r) => r.name === "Claimed by person");
    expect(ready).toMatchObject({ table: "expense_claims", groupBy: "claimant", show: "sum:amount", chart: "bar" });
    // its numbers come from the normal summary
    await admin.get(`/api/table/expense_claims/summary?groupBy=claimant&fn=sum&field=amount`).expect(200);
    if (!had) {
      await admin.del("/api/apps/expenses").expect(200);
      expect((await reportsOf(admin)).some((r) => r.name === "Claimed by person")).toBe(false);
    }
  });
});
