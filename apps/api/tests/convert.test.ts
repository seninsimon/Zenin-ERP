import { describe, expect, it } from "vitest";
import { login, setupWorld } from "./helpers.js";

// Make a typed field a formula (column settings, = in the spreadsheet):
// checked on every record first, then the whole column; Change back puts the
// old values back. And the spreadsheet's totals row.
describe("Make it a formula", async () => {
  const admin = await login();
  const { table, user } = await setupWorld(admin, {
    columns: [
      { name: "name", label: "Name" },
      { name: "qty", label: "Qty", type: "number" },
      { name: "price", label: "Price", type: "number" },
      { name: "amount", label: "Amount", type: "number" },
      { name: "status", label: "Status", type: "choice", options: [{ label: "Open" }, { label: "Paid" }] },
    ],
  });
  // 10 right, 1 typed wrong (Wrong), 1 empty (Empty)
  for (let i = 1; i <= 10; i++) await admin.post(`/api/table/${table}`, { name: `Line ${i}`, qty: i, price: 2.5, amount: i * 2.5 }).expect(200);
  await admin.post(`/api/table/${table}`, { name: "Wrong", qty: 2, price: 10, amount: 25 }).expect(200);
  await admin.post(`/api/table/${table}`, { name: "Empty", qty: 3, price: 10 }).expect(200);
  const rows = async () => ((await admin.get(`/api/table/${table}?limit=100&withRaw=1`)).body.data as { _raw: Record<string, unknown> }[]).map((r) => r._raw);
  const byName = async (name: string) => (await rows()).find((r) => r.name === name)!;
  const url = `/api/schema/${table}/column/amount/convert`;

  it("checks the formula on every record and shows what would change", async () => {
    const res = await admin.post(`${url}/check`, { expression: "{qty} * {price}" }).expect(200);
    expect(res.body.proof).toEqual({ checked: 11, fits: 10, differ: 1, fills: 1 });
    expect(res.body.examples).toEqual([expect.objectContaining({ title: "Wrong", now: "25", becomes: "20" })]);
  });

  it("refuses formulas that don't fit the field", async () => {
    expect((await admin.post(`${url}/check`, { expression: "{qty} *" })).status).toBe(400);
    expect((await admin.post(`${url}/check`, { expression: 'CONCAT({name}, "x")' })).body.message).toMatch(/gives text/);
    expect((await admin.post(`${url}/check`, { expression: "{amount} * 2" })).body.message).toMatch(/circle/);
    expect((await admin.post(`/api/schema/${table}/column/status/convert/check`, { expression: "{qty}" })).body.message).toMatch(/only Number, Date and Text/);
    // staff can't
    expect((await user.post(`${url}/check`, { expression: "{qty} * {price}" })).status).toBe(403);
    expect((await user.post(url, { expression: "{qty} * {price}" })).status).toBe(403);
  });

  it("makes the whole column a formula; new records work it out too", async () => {
    const res = await admin.post(url, { expression: "{qty} * {price}" }).expect(200);
    expect(res.body).toMatchObject({ changed: 2, data: { type: "formula", formula: { expression: "{qty} * {price}", type: "number" } } });
    expect((await byName("Wrong")).amount).toBe(20);
    expect((await byName("Empty")).amount).toBe(30);
    await admin.post(`/api/table/${table}`, { name: "New", qty: 4, price: 5 }).expect(200);
    expect((await byName("New")).amount).toBe(20);
    expect((await admin.get(url).expect(200)).body.conversion).toEqual({ from: "number", changed: 2 });
    // a formula can't be made a formula again
    expect((await admin.post(url, { expression: "{qty}" })).status).toBe(400);
  });

  it("Change back: a typed field again, with the old values back", async () => {
    const res = await admin.del(url).expect(200);
    expect(res.body).toMatchObject({ changed: 2, data: { type: "number" } });
    expect((await byName("Wrong")).amount).toBe(25);
    expect((await byName("Empty")).amount ?? null).toBeNull(); // empty again
    expect((await byName("New")).amount).toBe(20); // added since: keeps today's value
    expect((await admin.get(url).expect(200)).body.conversion).toBeNull();
    expect((await admin.del(url)).status).toBe(409);
  });

  it("a deleted field has nothing to change back", async () => {
    await admin.post(url, { expression: "{qty} * {price}" }).expect(200);
    await admin.del(`/api/schema/${table}/column/amount`).expect(200);
    await admin.post(`/api/schema/${table}/column`, { name: "amount", label: "Amount", type: "formula", formula: { expression: "{qty}" } }).expect(200);
    expect((await admin.get(url).expect(200)).body.conversion).toBeNull();
  });

  it("totals: every matching record, not one page; hidden fields left out", async () => {
    const all = (await user.get(`/api/table/${table}/totals`).expect(200)).body;
    expect(all.count).toBe(13);
    expect(all.sums.qty).toBe(55 + 2 + 3 + 4);
    expect(all.sums.price).toBe(10 * 2.5 + 10 + 10 + 5);
    const some = (await user.get(`/api/table/${table}/totals?search=Line`).expect(200)).body;
    expect(some).toMatchObject({ count: 10, sums: { qty: 55 } });
    // only managers see Price: staff get no total for it
    await admin.put(`/api/schema/${table}/column/price`, { onlyLevels: ["manager"] }).expect(200);
    expect((await user.get(`/api/table/${table}/totals`).expect(200)).body.sums).not.toHaveProperty("price");
  });
});
