import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { parseDate, parseNumber } from "../src/migration/analyze.js";
import { login, unique } from "./helpers.js";

type Col = { index: number; source: string; name: string; label: string; type: string; include: boolean; options?: string[]; link?: { table: string; by: number; match: number }; unfit: number };
type Tbl = { key: string; source: string; tableName: string; include: boolean; rows: number; columns: Col[] };
type Mig = { _id: string; status: string; plan: { tables: Tbl[] }; result: { tables: { table: string; rowsInFile: number; imported: number; totals: { label: string; file: number; zenin: number; match: boolean }[]; problems: number }[]; problems: number; allMatch: boolean } | null; createdTables: string[]; appKey: string | null; hasProblems: boolean };

// Bring your data (Excel / CSV): plan, review, import, proof, remove.
describe("Bring your data", async () => {
  const admin = await login();
  const tag = unique("m").toLowerCase().replace(/[^a-z0-9]/g, "");

  // a clinic's workbook: 10 patients and 12 visits (one bad date, one unknown patient)
  const workbook = async () => {
    const wb = new ExcelJS.Workbook();
    const p = wb.addWorksheet(`Patients ${tag}`);
    p.addRow(["Code", "Name", "City", "Phone", "Joined"]);
    for (let i = 1; i <= 10; i++) p.addRow([`P${String(i).padStart(3, "0")}`, `Patient ${i}`, i % 3 ? "Thrissur" : "Kochi", `98470${i}`, `${String(i).padStart(2, "0")}/04/2026`]);
    const v = wb.addWorksheet(`Visits ${tag}`);
    v.addRow(["Patient", "Visit date", "Fee", "Paid"]);
    for (let i = 1; i <= 10; i++) v.addRow([`P${String(i).padStart(3, "0")}`, `1${i % 9}/05/2026`, i === 2 ? "1,200" : 500, i % 2 ? "Yes" : "No"]);
    v.addRow(["P001", "31/02/2026", 300, "Yes"]); // no 31 February
    v.addRow(["P099", "20/05/2026", 200, "No"]); // no such patient
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const upload = async (files: [Buffer, string][]) => {
    let r = admin.upload("/api/migration/upload");
    for (const [b, n] of files) r = r.attach("files", b, n);
    return r;
  };

  it("reads numbers and dates the way people write them", () => {
    expect([parseNumber("1,20,000.50"), parseNumber("₹ 1,200"), parseNumber("12%"), parseNumber("abc")]).toEqual([120000.5, 1200, 12, null]);
    expect([parseDate("03/04/2026"), parseDate("03/04/2026", "mdy"), parseDate("3 Mar 2026"), parseDate("2026-03-04"), parseDate("31/02/2026")]).toEqual([
      "2026-04-03",
      "2026-03-04",
      "2026-03-03",
      "2026-03-04",
      null,
    ]);
  });

  it("is off by default, and only admins switch it", async () => {
    await admin.put("/api/migration/settings", { enabled: false }).expect(200);
    expect((await admin.get("/api/migration")).body).toMatchObject({ enabled: false, imports: [] });
    expect((await upload([[await workbook(), "Clinic.xlsx"]])).status).toBe(403);
    const memberId = (await admin.get("/api/roles")).body.find((r: { name: string; appKey: string | null }) => r.name === "Member" && !r.appKey)._id;
    const username = unique("u").toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: memberId }).expect(201);
    expect((await (await login(username, "pass-123-pass")).put("/api/migration/settings", { enabled: true })).status).toBe(403);
    await admin.put("/api/migration/settings", { enabled: true }).expect(200);
  });

  let mig: Mig;
  it("works out tables, types and links before anything is saved", async () => {
    const res = await upload([[await workbook(), `Clinic ${tag}.xlsx`]]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    mig = res.body;
    expect(mig.status).toBe("review");
    const [patients, visits] = mig.plan.tables;
    expect(patients).toMatchObject({ source: `Patients ${tag}`, rows: 10 });
    const type = (t: Tbl, source: string) => t.columns.find((c) => c.source === source)!;
    expect(type(patients, "City")).toMatchObject({ type: "choice", options: ["Thrissur", "Kochi"] });
    expect(type(patients, "Joined").type).toBe("date");
    expect(type(patients, "Phone").type).toBe("text"); // never added up
    expect(type(patients, "Code").type).toBe("text");
    expect(type(visits, "Fee").type).toBe("number");
    expect(type(visits, "Paid").type).toBe("boolean");
    expect(type(visits, "Visit date")).toMatchObject({ type: "date", unfit: 1 });
    expect(type(visits, "Patient")).toMatchObject({ type: "relation", link: { table: patients.key, by: 0 } });
    expect(type(visits, "Patient").link!.match).toBeGreaterThanOrEqual(90);
    // nothing made yet
    expect((await admin.get(`/api/schema/${patients.tableName}`)).status).toBe(404);
  });

  it("the review can rename, leave out and change types", async () => {
    const plan = structuredClone(mig.plan);
    plan.tables[1].tableName = `Clinic visits ${tag}`;
    plan.tables[0].columns.find((c) => c.source === "Phone")!.include = false;
    plan.tables[0].columns.find((c) => c.source === "Name")!.label = "Full name";
    plan.tables[1].columns.find((c) => c.source === "Paid")!.type = "text";
    mig = (await admin.put(`/api/migration/${mig._id}/plan`, { plan }).expect(200)).body;
    expect(mig.plan.tables[1].tableName).toBe(`clinic_visits_${tag}`);
    expect(mig.plan.tables[1].columns.find((c) => c.source === "Paid")!.type).toBe("text");
    // a link can't be invented by hand
    const bad = structuredClone(mig.plan);
    bad.tables[0].columns.find((c) => c.source === "Full name" || c.source === "Name")!.type = "relation";
    expect((await admin.put(`/api/migration/${mig._id}/plan`, { plan: bad })).status).toBe(400);
  });

  it("imports in the background, links rows, and proves nothing was lost", async () => {
    await admin.post(`/api/migration/${mig._id}/import`).expect(202);
    await drainJobs();
    mig = (await admin.get(`/api/migration/${mig._id}`).expect(200)).body;
    expect(mig.status, JSON.stringify(mig)).toBe("done");
    const [patients, visits] = mig.result!.tables;
    expect(patients).toMatchObject({ rowsInFile: 10, imported: 10, problems: 0 });
    expect(visits).toMatchObject({ rowsInFile: 12, imported: 12, problems: 2 });
    expect(visits.totals).toEqual([{ column: "fee", label: "Fee", file: 1200 + 9 * 500 + 300 + 200, zenin: 6200, match: true }]);
    expect(mig.result!.allMatch).toBe(true);

    // the tables, in a new app
    const pSchema = (await admin.get(`/api/schema/${mig.plan.tables[0].tableName}`).expect(200)).body;
    expect(pSchema.columns.map((c: { name: string }) => c.name)).toEqual(["code", "name", "city", "joined"]); // no phone
    expect(pSchema.columns.find((c: { name: string }) => c.name === "name").label).toBe("Full name");
    expect(pSchema.app.key).toBe(mig.appKey);
    // visits link to the patient records
    const pIds = new Set(((await admin.get(`/api/table/${mig.plan.tables[0].tableName}?limit=100`)).body.data as { _id: string }[]).map((r) => r._id));
    const rows = (await admin.get(`/api/table/${mig.plan.tables[1].tableName}?limit=100&withRaw=1`)).body.data as { _raw: Record<string, unknown> }[];
    expect(rows.filter((r) => pIds.has(String(r._raw.patient))).length).toBe(11); // P099 has none
    expect(rows.some((r) => r._raw.visit_date === "2026-05-11")).toBe(true); // 11/05/2026, day first

    // the values that didn't fit, as a file
    const csv = (await admin.get(`/api/migration/${mig._id}/problems`).expect(200)).text;
    expect(csv).toContain("Not a date");
    expect(csv).toContain("No matching record");
    expect(csv).toContain("P099");
  });

  it("CSV files work too, and names already taken are caught", async () => {
    const customers = Buffer.from(["Customer ID,Name", ...Array.from({ length: 10 }, (_, i) => `C${i},Shop ${i}`)].join("\n"));
    const orders = Buffer.from(["Order,Customer ID,Amount", ...Array.from({ length: 10 }, (_, i) => `O${i},C${i},"1,000"`)].join("\n"));
    const res = await upload([[customers, `cust_${tag}.csv`], [orders, `orders_${tag}.csv`]]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const m: Mig = res.body;
    expect(m.plan.tables.map((t) => t.tableName)).toEqual([`cust_${tag}`, `orders_${tag}`]);
    expect(m.plan.tables[1].columns.find((c) => c.source === "Customer ID")).toMatchObject({ type: "relation", link: { table: m.plan.tables[0].key } });
    // a name that's taken
    const plan = structuredClone(m.plan);
    plan.tables[0].tableName = mig.plan.tables[0].tableName;
    expect((await admin.put(`/api/migration/${m._id}/plan`, { plan })).status).toBe(400);
    await admin.del(`/api/migration/${m._id}`).expect(200);
  });

  it("an import can be removed: its tables, records and app go", async () => {
    const tables = mig.createdTables;
    await admin.del(`/api/migration/${mig._id}`).expect(200);
    for (const t of tables) expect((await admin.get(`/api/schema/${t}`)).status).toBe(404);
    expect((await admin.get("/api/apps")).body.apps.some((a: { key: string; installed: unknown }) => a.key === mig.appKey && a.installed)).toBe(false);
    expect((await admin.get(`/api/migration/${mig._id}`)).status).toBe(404);
  });

  it("refuses files it can't read", async () => {
    expect((await upload([[Buffer.from("hello"), "notes.pdf"]])).status).toBe(400);
    expect((await upload([[Buffer.from("not really excel"), "broken.xlsx"]])).status).toBe(400);
    await admin.put("/api/migration/settings", { enabled: false }).expect(200);
  });
});
