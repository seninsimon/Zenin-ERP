import { afterEach, describe, expect, it, vi } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

type Rule = { id: string; table: string; column: string; kind: string; expression?: string; rollup?: { from: string; via: string; fn: string; field?: string }; says: string; hint?: string; checked: number; fits: number; differ: number; fills: number; used: boolean; changed: number };
type Mig = { _id: string; status: string; plan: { tables: { tableName: string }[] }; rules: Rule[] | null };

// Bring your data, part 4: the old system's calculations, found in the data
// itself and proved on every record. No AI is involved (fetch would throw).
afterEach(() => vi.unstubAllGlobals());

describe("Bring your data: rules found in the data", async () => {
  const admin = await login();
  const tag = unique("r").toLowerCase().replace(/[^a-z0-9]/g, "");
  await admin.put("/api/migration/settings", { enabled: true }).expect(200);

  // a shop: 20 customers, 20 invoices, 60 invoice lines; one line's amount is wrong
  const firsts = ["Anu", "Biju", "Chitra", "Deepa", "Eldho", "Faisal", "Gopi", "Hari", "Indu", "Jose"];
  const lasts = ["Thomas", "Nair", "Menon", "Varghese"];
  const prices = [12.5, 99, 250.75, 40, 7.25, 120, 18, 333.33];
  const customers = ["Code,First name,Last name,Full name"];
  const invoices = ["Invoice,Customer,Date,Due date,Subtotal,Tax,Total"];
  const lines = ["Invoice,Item,Qty,Price,Amount"];
  let n = 0;
  for (let i = 1; i <= 20; i++) {
    const [first, last] = [firsts[i % 10], lasts[i % 4]];
    customers.push(`C${i},${first},${last},${first} ${last}`);
    let cents = 0;
    for (let k = 0; k < 3; k++) {
      n++;
      const qty = (n % 7) + 1;
      const price = prices[n % 8];
      const amount = Math.round(qty * price * 100) + (n === 17 ? 1000 : 0); // line 17: 10 too much
      cents += amount;
      lines.push(`INV-${i},Item ${n},${qty},${price},${amount / 100}`);
    }
    const tax = Math.floor((cents * 18 + 50) / 100); // 18%, rounded half up to paise
    const date = new Date(Date.UTC(2026, 2, i));
    const due = new Date(date.getTime() + 30 * 86_400_000);
    invoices.push(`INV-${i},C${i},${date.toISOString().slice(0, 10)},${due.toISOString().slice(0, 10)},${cents / 100},${tax / 100},${(cents + tax) / 100}`);
  }
  const cust = `cust_${tag}`;
  const inv = `inv_${tag}`;
  const line = `lines_${tag}`;
  let mig: Mig;

  it("finds the calculations after the import, without any AI", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("no AI here")));
    vi.stubGlobal("fetch", fetch);
    const res = await admin
      .upload("/api/migration/upload")
      .attach("files", Buffer.from(customers.join("\n")), `${cust}.csv`)
      .attach("files", Buffer.from(invoices.join("\n")), `${inv}.csv`)
      .attach("files", Buffer.from(lines.join("\n")), `${line}.csv`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await admin.post(`/api/migration/${res.body._id}/import`).expect(202);
    await drainJobs();
    mig = (await admin.get(`/api/migration/${res.body._id}`).expect(200)).body;
    expect(mig.status).toBe("done");
    expect(fetch).not.toHaveBeenCalled();

    const found = Object.fromEntries(mig.rules!.map((r) => [r.id, r.expression ?? `${r.rollup!.fn}:${r.rollup!.from}.${r.rollup!.field ?? ""}`]));
    expect(found).toEqual({
      [`${cust}.full_name`]: `CONCAT({first_name}, " ", {last_name})`,
      [`${inv}.due_date`]: "ADD_DAYS({date}, 30)",
      [`${inv}.subtotal`]: `sum:${line}.amount`,
      [`${inv}.tax`]: "ROUND({subtotal} * 0.18, 2)",
      [`${inv}.total`]: "{subtotal} + {tax}",
      [`${line}.amount`]: "{qty} * {price}",
    }); // not Price = Amount ÷ Qty, nor Date = Due date − 30 days
    const byId = (id: string) => mig.rules!.find((r) => r.id === id)!;
    expect(byId(`${inv}.tax`)).toMatchObject({ says: "Tax = Subtotal × 0.18", hint: "18% of Subtotal, rounded to 2 decimals", checked: 20, fits: 20 });
    expect(byId(`${line}.amount`)).toMatchObject({ says: "Amount = Qty × Price", checked: 60, fits: 59, differ: 1, used: false });
    expect(byId(`${inv}.subtotal`).says).toMatch(/^Subtotal = the sum of Amount on its Lines/);
    expect(byId(`${cust}.full_name`).says).toBe("Full name = First name + a space + Last name");
  });

  it("checks a rule on today's records and shows what it would change", async () => {
    const res = await admin.get(`/api/migration/${mig._id}/rules/${line}.amount`).expect(200);
    expect(res.body.proof).toMatchObject({ checked: 60, fits: 59, differ: 1, fills: 0 });
    expect(res.body.examples).toHaveLength(1);
    const ex = res.body.examples[0];
    expect(Number(ex.now) - Number(ex.becomes)).toBeCloseTo(10);
  });

  it("uses a rule: the field becomes a formula; Change back puts the old values back", async () => {
    const wrong = async () => {
      const rows = (await admin.get(`/api/table/${line}?limit=100&withRaw=1`)).body.data as { _raw: { qty: number; price: number; amount: number; item: string } }[];
      return rows.find((r) => r._raw.item === "Item 17")!._raw;
    };
    const before = await wrong();
    mig = (await admin.post(`/api/migration/${mig._id}/rules/${line}.amount/use`).expect(200)).body;
    const used = mig.rules!.find((r) => r.id === `${line}.amount`)!;
    expect(used).toMatchObject({ used: true, changed: 1 });
    expect(used).not.toHaveProperty("restore");
    expect(used).not.toHaveProperty("original");
    let schema = (await admin.get(`/api/schema/${line}`).expect(200)).body;
    expect(schema.columns.find((c: { name: string }) => c.name === "amount")).toMatchObject({ type: "formula", formula: { expression: "{qty} * {price}", type: "number" } });
    const fixed = await wrong();
    expect(fixed.amount).toBeCloseTo(fixed.qty * fixed.price);
    // a new line works its amount out
    await admin.post(`/api/table/${line}`, { item: "New", qty: 3, price: 10 }).expect(200);
    const fresh = ((await admin.get(`/api/table/${line}?limit=100&withRaw=1`)).body.data as { _raw: { item: string; amount: number } }[]).find((r) => r._raw.item === "New")!;
    expect(fresh._raw.amount).toBe(30);
    // using it twice is refused
    await admin.post(`/api/migration/${mig._id}/rules/${line}.amount/use`).expect(409);

    mig = (await admin.post(`/api/migration/${mig._id}/rules/${line}.amount/undo`).expect(200)).body;
    expect(mig.rules!.find((r) => r.id === `${line}.amount`)!.used).toBe(false);
    schema = (await admin.get(`/api/schema/${line}`).expect(200)).body;
    expect(schema.columns.find((c: { name: string }) => c.name === "amount").type).toBe("number");
    expect((await wrong()).amount).toBe(before.amount);
  });

  it("a total over linked records becomes a roll-up", async () => {
    mig = (await admin.post(`/api/migration/${mig._id}/rules/${inv}.subtotal/use`).expect(200)).body;
    expect(mig.rules!.find((r) => r.id === `${inv}.subtotal`)).toMatchObject({ used: true, changed: 0 });
    const schema = (await admin.get(`/api/schema/${inv}`).expect(200)).body;
    expect(schema.columns.find((c: { name: string }) => c.name === "subtotal")).toMatchObject({ type: "rollup", rollup: { from: line, fn: "sum", field: "amount" } });
    // looking again keeps the rule in use, and finds the rest again
    mig = (await admin.post(`/api/migration/${mig._id}/rules`).expect(200)).body;
    expect(mig.rules!.find((r) => r.id === `${inv}.subtotal`)!.used).toBe(true);
    expect(mig.rules!.map((r) => r.id).sort()).toEqual(
      [`${cust}.full_name`, `${inv}.due_date`, `${inv}.subtotal`, `${inv}.tax`, `${inv}.total`, `${line}.amount`].sort()
    );
  });

  it("only admins, and only after the import", async () => {
    await admin.del(`/api/migration/${mig._id}`).expect(200);
    await admin.put("/api/migration/settings", { enabled: false }).expect(200);
  });
});
