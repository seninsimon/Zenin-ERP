import { parse } from "csv-parse/sync";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { anonymous, login, unique } from "./helpers.js";

type AppOption = { key: string; name: string; levels: { level: string; label: string }[] };

// "Import people" (Settings → Users): many logins from one CSV file.
describe("Import people from a CSV file", async () => {
  const admin = await login();
  await admin.put("/api/email", { provider: "gmail", user: "office@example.com", pass: "x".repeat(16), appUrl: "http://erp.local" }).expect(200);
  // Expenses for an app column; removed again afterwards if it wasn't there
  const hadExpenses = !!(await admin.get("/api/apps")).body.apps.find((a: { key: string; installed: unknown }) => a.key === "expenses")?.installed;
  if (!hadExpenses) await admin.post("/api/apps/install", { apps: ["expenses"] }).expect(200);
  afterAll(async () => {
    if (hadExpenses) return;
    await admin.del("/api/apps/expenses").expect(200);
    if ((await admin.get("/api/schema/expense_claims")).status === 200) await admin.del("/api/schema/expense_claims");
  });
  const expenses = ((await admin.get("/api/users/app-access")).body as AppOption[]).find((a) => a.key === "expenses")!;
  const sales = (await admin.post("/api/departments", { name: unique("Sales") })).body.department;
  const tag = unique("imp").toLowerCase().replace(/_/g, "");
  const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const header = ["Full name", "Username", "Email", "Phone", "Departments", expenses.name];
  const userNamed = async (username: string) => (await query<{ _id: string; must_change_password: boolean; is_active: boolean }>(`SELECT _id, must_change_password, is_active FROM users WHERE username = $1`, [username])).rows[0];

  it("the template has a column for each detail and each app", async () => {
    const res = await admin.get("/api/users/import/template").expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const [columns] = parse(res.text, { bom: true }) as string[][];
    expect(columns.slice(0, 5)).toEqual(["Full name", "Username", "Email", "Phone", "Departments"]);
    expect(columns).toContain(expenses.name);
  });

  it("Check shows each row's problems and saves nothing", async () => {
    const taken = unique("taken").toLowerCase();
    await admin.post("/api/users", { username: taken, password: "pass-123-pass", roleId: (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member")._id }).expect(201);
    const csv = csvOf([
      header,
      ["Asha Menon", "", `asha.${tag}@example.com`, "", sales.name, "Manager"],
      ["", "", "", "", "", ""].map((c, i) => (i === 3 ? "999" : c)), // only a phone: no name
      ["Bad Email", "", "not-an-email", "", "", ""],
      ["Wrong Dept", "", "", "", "Nowhere", ""],
      ["Wrong Level", "", "", "", "", "Boss"],
      ["Taken Name", taken, "", "", "", ""],
      ["Twin One", "", `twin.${tag}@example.com`, "", "", ""],
      ["Twin Two", "", `TWIN.${tag}@example.com`, "", "", ""],
    ]);
    const res = (await admin.post("/api/users/import/check", { csv }).expect(200)).body;
    const byName = (n: string) => res.rows.find((r: { fullName: string }) => r.fullName === n);
    expect(byName("Asha Menon")).toMatchObject({ username: `asha.${tag}`, problems: [], gets: "link", access: { [expenses.name]: "Manager" } });
    expect(res.rows.find((r: { line: number }) => r.line === 3).problems).toEqual(["Full name is empty"]);
    expect(byName("Bad Email").problems).toEqual(["Email doesn't look right"]);
    expect(byName("Wrong Dept").problems).toEqual(['No department called "Nowhere"']);
    expect(byName("Wrong Level").problems[0]).toContain('no level called "Boss"');
    expect(byName("Taken Name").problems).toEqual(["This username is already taken"]);
    expect(byName("Twin Two").problems).toEqual(["Same email as line 8"]);
    expect(byName("Twin One").gets).toBe("link");
    expect(res).toMatchObject({ ready: 2, withProblems: 6, mailWorks: true });
    expect(await userNamed(`asha.${tag}`)).toBeUndefined();
  });

  it("Import adds the good rows; the rest come back as a file to fix", async () => {
    const csv = csvOf([
      header,
      ["Biju Thomas", "", `biju.${tag}@example.com`, "98470 00000", sales.name, "Staff"],
      ["Chitra Nair", `chitra.${tag}`, "", "", "", expenses.levels.at(-1)!.label],
      ["", "", "", "12345", "", ""], // a phone but no name
    ]);
    const res = (await admin.post("/api/users/import", { csv }).expect(201)).body;
    expect(res).toMatchObject({ added: 2, invited: 1, withPassword: 1, notAdded: 1 });

    // Biju has an email: the welcome link, and he's a Member with Expenses · Staff in Sales
    const users = (await admin.get("/api/users")).body;
    const biju = users.find((u: { username: string }) => u.username === `biju.${tag}`);
    expect(biju).toMatchObject({ fullName: "Biju Thomas", phone: "98470 00000", appAccess: { expenses: "staff" } });
    expect(biju.role.name).toBe("Member");
    expect(biju.departments.map((d: { _id: string }) => d._id)).toEqual([sales._id]);
    await processOutbox();
    expect(memoryMailbox.some((m) => m.to === `biju.${tag}@example.com` && /set-password\?token=/.test(m.text))).toBe(true);
    expect((await userNamed(`biju.${tag}`)).must_change_password).toBe(false);

    // the problem row, as it was, with a "Problem" column
    const [problemHeader, problemRow] = parse(res.problemsCsv, { bom: true }) as string[][];
    expect(problemHeader).toEqual([...header, "Problem"]);
    expect(problemRow.at(-1)).toBe("Full name is empty");

    // Chitra has no email: a temporary password, shown once
    const [pwHeader, pwRow] = parse(res.passwordsCsv, { bom: true }) as string[][];
    expect(pwHeader).toEqual(["Full name", "Username", "Temporary password"]);
    expect(pwRow.slice(0, 2)).toEqual(["Chitra Nair", `chitra.${tag}`]);
    expect(pwRow[2]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect((await userNamed(`chitra.${tag}`)).must_change_password).toBe(true);

    // every person added is in the audit log
    const { rows: logged } = await query(`SELECT 1 FROM audit_log WHERE action = 'create' AND entity = 'user' AND changes->>'imported' = 'true' AND changes->>'username' IN ($1, $2)`, [`biju.${tag}`, `chitra.${tag}`]);
    expect(logged.length).toBe(2);

    // the same file again: they're already here
    const again = (await admin.post("/api/users/import/check", { csv }).expect(200)).body;
    expect(again.rows[0].problems).toEqual(["Someone here already has this email"]);
    expect(again.rows[1].problems).toEqual(["This username is already taken"]);
  });

  it("a temporary password must be changed before anything else", async () => {
    const csv = csvOf([header, ["Devi Pillai", `devi.${tag}`, "", "", "", ""]]);
    const res = (await admin.post("/api/users/import", { csv }).expect(201)).body;
    const password = (parse(res.passwordsCsv, { bom: true }) as string[][])[1][2];
    const devi = await login(`devi.${tag}`, password);
    expect((await devi.get("/api/auth/me").expect(200)).body.user.mustChangePassword).toBe(true);
    const blocked = await devi.get("/api/users/options");
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toBe("Choose a new password first");
    await devi.put("/api/auth/password", { currentPassword: password, newPassword: "devi-own-pass-1" }).expect(200);
    expect((await devi.get("/api/auth/me").expect(200)).body.user.mustChangePassword).toBe(false);
    await devi.get("/api/users/options").expect(200);
  });

  it("refuses files that are too big, empty, or without names", async () => {
    const big = csvOf([header, ...Array.from({ length: 501 }, (_, i) => [`P ${i}`, "", "", "", "", ""])]);
    expect((await admin.post("/api/users/import/check", { csv: big })).body.message).toContain("At most 500");
    expect((await admin.post("/api/users/import/check", { csv: "Full name\n" })).body.message).toBe("The file has no people in it");
    expect((await admin.post("/api/users/import/check", { csv: "Name,Email\nA,b@c.de" })).body.message).toContain('"Full name" column');
  });

  it("only administrators can import", async () => {
    const csv = csvOf([header, ["Eva", `eva.${tag}`, "", "", "", ""]]);
    const res = (await admin.post("/api/users/import", { csv }).expect(201)).body;
    const password = (parse(res.passwordsCsv, { bom: true }) as string[][])[1][2];
    const eva = await login(`eva.${tag}`, password);
    await eva.put("/api/auth/password", { currentPassword: password, newPassword: "eva-own-pass-12" }).expect(200);
    expect((await eva.post("/api/users/import/check", { csv })).status).toBe(403);
    expect((await eva.get("/api/users/import/template")).status).toBe(403);
  });

  it("disables several people at once, never yourself, and signs them out", async () => {
    const csv = csvOf([header, ["Fida", `fida.${tag}`, "", "", "", ""], ["Gopi", `gopi.${tag}`, "", "", "", ""]]);
    const res = (await admin.post("/api/users/import", { csv }).expect(201)).body;
    const passwords = (parse(res.passwordsCsv, { bom: true }) as string[][]).slice(1);
    const fida = await login(`fida.${tag}`, passwords[0][2]);
    await fida.get("/api/auth/me").expect(200);
    const me = (await admin.get("/api/auth/me")).body.user;
    const ids = [(await userNamed(`fida.${tag}`))._id, (await userNamed(`gopi.${tag}`))._id, me._id];
    const out = (await admin.post("/api/users/disable", { ids }).expect(200)).body;
    expect(out.disabled).toBe(2);
    expect(out.skipped).toEqual([{ id: me._id, name: me.fullName || me.username, reason: "You can't disable your own account" }]);
    expect((await userNamed(`gopi.${tag}`)).is_active).toBe(false);
    expect((await fida.get("/api/auth/me")).status).toBe(401);
    expect((await (await anonymous()).post("/api/auth/login", { username: `gopi.${tag}`, password: passwords[1][2] })).status).not.toBe(200);
    expect((await admin.post("/api/users/disable", { ids: [] })).status).toBe(400);
  });
});
