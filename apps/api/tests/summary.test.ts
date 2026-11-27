import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Summary on any list (docs/WORKFLOW.md): records grouped by
// one column, with a count, sum or average; same permissions as the list.
describe("Summary on a list", async () => {
  const admin = await login();
  const memberId = ((await admin.get("/api/roles")).body as { _id: string; name: string; appKey: string | null }[]).find((r) => r.name === "Member" && !r.appKey)!._id;
  const app = (await admin.post("/api/apps/own", { name: unique("Sales"), icon: "IconCash" }).expect(201)).body as { key: string };
  const clients = unique("clients");
  const deals = unique("deals");
  await admin.post("/api/schema", { tableName: clients, byDepartment: false, app: app.key, staff: "view", columns: [{ name: "name", label: "Name" }] }).expect(200);
  await admin
    .post("/api/schema", {
      tableName: deals,
      byDepartment: false,
      app: app.key,
      staff: "work",
      columns: [
        { name: "title", label: "Title" },
        { name: "stage", label: "Stage", type: "choice", options: [{ label: "Lead" }, { label: "Won" }, { label: "Lost" }] },
        { name: "tags", label: "Tags", type: "choice", multiple: true, options: [{ label: "Hot" }, { label: "Big" }] },
        { name: "amount", label: "Amount", type: "number" },
        { name: "margin", label: "Margin", type: "number", onlyLevels: ["manager"] },
        { name: "closed", label: "Closed", type: "date" },
        { name: "paid", label: "Paid", type: "boolean" },
        { name: "client", label: "Client", type: "relation", ref: clients },
        { name: "owner", label: "Owner", type: "user" },
      ],
    })
    .expect(200);
  const person = async (level: string) => {
    const username = unique(level).toLowerCase();
    const id = (await admin.post("/api/users", { username, fullName: `Rep ${level}`, password: "pass-123-pass", roleId: memberId, appAccess: { [app.key]: level } }).expect(201)).body.user._id as string;
    return { id, client: await login(username, "pass-123-pass") };
  };
  const rep = await person("staff");
  const acme = (await admin.post(`/api/table/${clients}`, { name: "Acme" }).expect(200)).body.data.insertedId;
  const add = (data: object) => admin.post(`/api/table/${deals}`, data).expect(200);
  await add({ title: "A", stage: "Won", tags: ["Hot", "Big"], amount: 100, margin: 10, closed: "2026-10-05", paid: true, client: acme, owner: rep.id });
  await add({ title: "B", stage: "Won", tags: ["Hot"], amount: 50, closed: "2026-10-20", paid: false, client: acme });
  await add({ title: "C", stage: "Lead", amount: 20, closed: "2026-11-02" });
  await add({ title: "D", stage: "Lost" });
  const summary = async (client: typeof admin, q: Record<string, string>) => {
    const res = await client.get(`/api/table/${deals}/summary?${new URLSearchParams(q)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { groups: { key: string | null; label: string; count: number; value: number | null }[]; others: unknown; total: { count: number; value: number | null } };
  };
  const pairs = (s: Awaited<ReturnType<typeof summary>>) => s.groups.map((g) => [g.label, g.count, g.value]);

  it("counts by a choice, in the choice's own order", async () => {
    const s = await summary(admin, { groupBy: "stage" });
    expect(pairs(s)).toEqual([["Lead", 1, 1], ["Won", 2, 2], ["Lost", 1, 1]]);
    expect(s.total).toEqual({ count: 4, value: 4 });
  });

  it("adds up or averages a number column", async () => {
    expect(pairs(await summary(admin, { groupBy: "stage", fn: "sum", field: "amount" }))).toEqual([["Lead", 1, 20], ["Won", 2, 150], ["Lost", 1, 0]]);
    const avg = await summary(admin, { groupBy: "stage", fn: "avg", field: "amount" });
    expect(pairs(avg)).toEqual([["Lead", 1, 20], ["Won", 2, 75], ["Lost", 1, null]]); // no amounts: no average
    expect(avg.total.value).toBe(56.67);
  });

  it("dates by month, oldest first; empty last", async () => {
    expect(pairs(await summary(admin, { groupBy: "closed", fn: "sum", field: "amount" }))).toEqual([["Oct 2026", 2, 150], ["Nov 2026", 1, 20], ["Not set", 1, 0]]);
  });

  it("people, links and Yes/No by name; several values count in each", async () => {
    expect(pairs(await summary(admin, { groupBy: "owner" }))).toEqual([["Rep staff", 1, 1], ["Not set", 3, 3]]);
    expect(pairs(await summary(admin, { groupBy: "client" }))).toEqual([["Acme", 2, 2], ["Not set", 2, 2]]);
    expect(pairs(await summary(admin, { groupBy: "paid" }))).toEqual([["Yes", 1, 1], ["No", 1, 1], ["Not set", 2, 2]]);
    expect(pairs(await summary(admin, { groupBy: "tags" }))).toEqual([["Hot", 2, 2], ["Big", 1, 1], ["Not set", 2, 2]]);
  });

  it("follows the list's filters and search", async () => {
    const filters = JSON.stringify([{ field: "stage", op: "in", value: ["Won"] }]);
    expect(pairs(await summary(admin, { groupBy: "client", filters }))).toEqual([["Acme", 2, 2]]);
    expect((await summary(admin, { groupBy: "stage", search: "Lead" })).total.count).toBe(1);
  });

  it("counts only what the person may see, and never a hidden field", async () => {
    // staff see only their own deals from now on
    await admin.put(`/api/access-levels/${app.key}/staff`, { permissions: { [deals]: { view: true, create: true, edit: true, own: true }, [clients]: { view: true } } }).expect(200);
    const mine = await summary(rep.client, { groupBy: "stage" });
    expect(mine.total.count).toBe(1);
    expect(pairs(mine)).toEqual([["Won", 1, 1]]);
    const hidden = await rep.client.get(`/api/table/${deals}/summary?groupBy=stage&fn=sum&field=margin`);
    expect(hidden.status).toBe(400);
    expect(hidden.body.message).toBe('You can\'t group or add up "Margin"');
    expect((await admin.get(`/api/table/${deals}/summary?groupBy=stage&fn=sum&field=margin`)).status).toBe(200);
  });

  it("refuses columns it can't group or add up", async () => {
    expect((await admin.get(`/api/table/${deals}/summary?groupBy=title`)).status).toBe(400);
    expect((await admin.get(`/api/table/${deals}/summary?groupBy=stage&fn=sum&field=title`)).status).toBe(400);
  });
});
