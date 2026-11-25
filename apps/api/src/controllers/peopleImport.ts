import { randomInt } from "node:crypto";
import type { Request, Response } from "express";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { accessOptions, rolesForAccess, type AccessOption } from "../apps/access.js";
import { addToDirectory, directoryTable } from "../apps/directory.js";
import { hashPassword } from "../auth/password.js";
import { sendPasswordLink, unusablePasswordHash } from "../auth/passwordLinks.js";
import { query } from "../db/pool.js";
import { HttpError, isValidEmail, toIdList, USERNAME_PATTERN } from "../lib/http.js";
import { mailEnabled } from "../mail/mailer.js";
import { link } from "../mail/render.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { countActiveAdmins, createUser, deleteUserSessions, getUserById, listDepartments, updateUser } from "../repo/userRepo.js";

// "Import people": many logins from one CSV file (Administration → Users).
//   1. Download the template: one column per detail, one per app.
//   2. Check: every row, with what's wrong (nothing is saved).
//   3. Import: the good rows become people; the rest come back as a file.
// Everyone imported is a Member (never an Administrator). People with an
// email get the welcome link when email is set up; everyone else gets a
// temporary password, shown once, which they must change at first sign-in.

export const MAX_ROWS = 500;

const BASE_COLUMNS = ["Full name", "Username", "Email", "Phone", "Departments"] as const;

type Row = {
  line: number; // the row's line in the file (the header is line 1)
  fullName: string;
  username: string;
  email: string;
  phone: string;
  departments: string[]; // names, as typed
  access: Record<string, string>; // app name -> level label, as typed
  problems: string[];
  // filled in when the row is fine:
  departmentIds: string[];
  appAccess: Record<string, string>; // launcher key -> level
  gets: "link" | "password";
  raw: Record<string, string>;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// GET /users/import/template: the columns, with no rows
export async function importTemplateHandler(_req: Request, res: Response) {
  const apps = await accessOptions();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="people-template.csv"');
  res.send(stringify([[...BASE_COLUMNS, ...apps.map((a) => a.name)]], { bom: true }));
}

function readCsv(csv: unknown): Record<string, string>[] {
  if (typeof csv !== "string" || !csv.trim()) throw new HttpError(400, "Choose a CSV file first");
  let records: Record<string, string>[];
  try {
    records = parse(csv, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch {
    throw new HttpError(400, "This file couldn't be read as CSV. Save it from Excel or Google Sheets as \"CSV\" and try again.");
  }
  // rows with nothing in them (Excel often leaves a few at the end)
  records = records.filter((r) => Object.values(r).some((v) => String(v ?? "").trim()));
  if (!records.length) throw new HttpError(400, "The file has no people in it");
  if (records.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} people per file: split it into smaller files`);
  return records;
}

// a username from the email or the name: "meera.nair"
const baseUsername = (email: string, fullName: string) => {
  const from = email ? email.split("@")[0] : fullName;
  let name = from
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
  if (name.length < 3) name = `${name || "user"}.user`.slice(0, 40);
  return name;
};

// Every row, checked against the file and against who's already here.
async function checkRows(csv: unknown) {
  const records = readCsv(csv);
  const apps = await accessOptions();
  const departments = await listDepartments();
  // welcome links need email set up, with "Links in emails go to"
  const mailWorks = (await mailEnabled()) && !!(await link("/set-password"));
  const { rows: existing } = await query<{ username: string; email: string | null }>(`SELECT username, email FROM users`);
  const takenUsernames = new Set(existing.map((u) => u.username.toLowerCase()));
  const takenEmails = new Set(existing.map((u) => (u.email ?? "").toLowerCase()).filter(Boolean));

  // which column is which (any case, extra spaces)
  const headers = Object.keys(records[0]);
  const find = (name: string) => headers.find((h) => norm(h) === norm(name));
  const base = Object.fromEntries(BASE_COLUMNS.map((c) => [c, find(c)])) as Record<(typeof BASE_COLUMNS)[number], string | undefined>;
  const appColumns = apps.map((a) => ({ app: a, header: find(a.name) })).filter((x): x is { app: AccessOption; header: string } => !!x.header);
  const used = new Set([...Object.values(base), ...appColumns.map((x) => x.header)]);
  const ignoredColumns = headers.filter((h) => h && !used.has(h));
  if (!base["Full name"]) throw new HttpError(400, 'The file needs a "Full name" column. Start from the template.');

  const inFileUsernames = new Map<string, number>();
  const inFileEmails = new Map<string, number>();
  const rows: Row[] = records.map((r, i) => {
    const get = (c: (typeof BASE_COLUMNS)[number]) => String((base[c] && r[base[c]!]) ?? "").trim();
    const row: Row = {
      line: i + 2,
      fullName: get("Full name").slice(0, 100),
      username: get("Username"),
      email: get("Email").slice(0, 200),
      phone: get("Phone").slice(0, 30),
      departments: get("Departments").split(";").map((d) => d.trim()).filter(Boolean),
      access: {},
      problems: [],
      departmentIds: [],
      appAccess: {},
      gets: "password",
      raw: r,
    };
    if (!row.fullName) row.problems.push("Full name is empty");

    if (row.email) {
      const key = row.email.toLowerCase();
      if (!isValidEmail(row.email)) row.problems.push("Email doesn't look right");
      else if (takenEmails.has(key)) row.problems.push("Someone here already has this email");
      else if (inFileEmails.has(key)) row.problems.push(`Same email as line ${inFileEmails.get(key)}`);
      else inFileEmails.set(key, row.line);
    }

    for (const name of row.departments) {
      const d = departments.find((x) => norm(x.name) === norm(name));
      if (d) row.departmentIds.push(d._id);
      else row.problems.push(`No department called "${name}"`);
    }

    for (const { app, header } of appColumns) {
      const value = String(r[header] ?? "").trim();
      if (!value || ["no access", "none", "no", "-"].includes(norm(value))) continue;
      row.access[app.name] = value;
      const level = app.levels.find((l) => norm(l.label) === norm(value) || norm(l.level) === norm(value));
      if (level) row.appAccess[app.key] = level.level;
      else row.problems.push(`${app.name}: no level called "${value}" (use ${app.levels.map((l) => l.label).join(", ")})`);
    }

    row.gets = row.email && mailWorks ? "link" : "password";
    return row;
  });

  // usernames last: typed ones must be free; empty ones are made up
  for (const row of rows) {
    if (row.username) {
      const key = row.username.toLowerCase();
      if (!USERNAME_PATTERN.test(row.username)) row.problems.push("Username: 3-50 letters, numbers, dot, dash or underscore");
      else if (takenUsernames.has(key)) row.problems.push("This username is already taken");
      else if (inFileUsernames.has(key)) row.problems.push(`Same username as line ${inFileUsernames.get(key)}`);
      else inFileUsernames.set(key, row.line);
    }
  }
  for (const row of rows) {
    if (row.username || !row.fullName) continue;
    const base = baseUsername(row.email, row.fullName);
    let candidate = base;
    for (let n = 2; takenUsernames.has(candidate) || inFileUsernames.has(candidate); n++) candidate = `${base}${n}`;
    row.username = candidate;
    inFileUsernames.set(candidate, row.line);
  }

  return { rows, apps, mailWorks, ignoredColumns, headers };
}

const preview = (row: Row) => ({
  line: row.line,
  fullName: row.fullName,
  username: row.username,
  email: row.email,
  departments: row.departments,
  access: row.access,
  gets: row.gets,
  problems: row.problems,
});

// POST /users/import/check { csv }: what would happen, nothing saved
export async function importCheckHandler(req: Request, res: Response) {
  const { rows, mailWorks, ignoredColumns } = await checkRows(req.body?.csv);
  res.json({
    rows: rows.map(preview),
    ready: rows.filter((r) => !r.problems.length).length,
    withProblems: rows.filter((r) => r.problems.length).length,
    mailWorks,
    ignoredColumns,
    hasDirectory: !!(await directoryTable()),
  });
}

// easy to read out and type: no 0/O, 1/l/I
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const temporaryPassword = () =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");

// POST /users/import { csv, addToDirectory }: adds the good rows
export async function importPeopleHandler(req: Request, res: Response) {
  const { rows, headers } = await checkRows(req.body?.csv);
  const { rows: memberRows } = await query<{ _id: string }>(
    `SELECT _id FROM roles WHERE name = 'Member' AND app_key IS NULL AND NOT is_admin ORDER BY created_at LIMIT 1`
  );
  if (!memberRows[0]) throw new HttpError(400, 'The "Member" access level is missing');
  const memberId = memberRows[0]._id;
  const by = currentUser(req);
  const wantDirectory = req.body?.addToDirectory === true;

  const good = rows.filter((r) => !r.problems.length);
  // temporary passwords for those without a welcome link (hashing is the slow part: all at once)
  const passwords = new Map(good.filter((r) => r.gets === "password").map((r) => [r.line, temporaryPassword()]));
  const hashes = new Map(
    await Promise.all(good.map(async (r) => [r.line, await (passwords.has(r.line) ? hashPassword(passwords.get(r.line)!) : unusablePasswordHash())] as const))
  );

  const added: { fullName: string; username: string; email: string; gets: "link" | "password"; password?: string }[] = [];
  let invited = 0;
  for (const row of good) {
    try {
      const extraRoleIds = Object.keys(row.appAccess).length ? await rolesForAccess([], row.appAccess) : [];
      const user = await createUser({
        username: row.username,
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        passwordHash: hashes.get(row.line)!,
        roleId: memberId,
        departmentIds: row.departmentIds,
        extraRoleIds,
        mustChangePassword: row.gets === "password",
      });
      await audit(req, {
        action: "create",
        entity: "user",
        recordId: user._id,
        changes: { username: user.username, fullName: user.fullName, email: user.email, role: "Member", appAccess: row.appAccess, imported: true },
      });
      if (wantDirectory) {
        const directory = await addToDirectory(user, by);
        if (directory) {
          await audit(req, { action: "create", entity: "record", tableName: directory.table, recordId: directory.id, changes: { account: { to: user.fullName || user.username } } });
        }
      }
      let gets = row.gets;
      if (gets === "link") {
        if (await sendPasswordLink(user, "invite").catch(() => false)) {
          invited++;
          await audit(req, { action: "password_link", entity: "user", recordId: user._id, changes: { purpose: "invite" } });
        } else {
          // the link couldn't go: a temporary password instead
          const password = temporaryPassword();
          await updateUser(user._id, { passwordHash: await hashPassword(password), mustChangePassword: true });
          passwords.set(row.line, password);
          gets = "password";
        }
      }
      added.push({ fullName: user.fullName, username: user.username, email: user.email ?? "", gets, ...(gets === "password" ? { password: passwords.get(row.line) } : {}) });
    } catch (error) {
      // someone took the username in the meantime, or similar
      row.problems.push(error instanceof Error && /unique|duplicate/i.test(error.message) ? "This username is already taken" : "Couldn't be added");
    }
  }

  const failed = rows.filter((r) => r.problems.length);
  // the rows to fix, as they were, with a "Problem" column: fix and import again
  const problemsCsv = failed.length
    ? stringify([[...headers, "Problem"], ...failed.map((r) => [...headers.map((h) => r.raw[h] ?? ""), r.problems.join("; ")])], { bom: true })
    : null;
  // shown once: the temporary passwords to hand out
  const withPassword = added.filter((a) => a.gets === "password");
  const passwordsCsv = withPassword.length
    ? stringify([["Full name", "Username", "Temporary password"], ...withPassword.map((a) => [a.fullName, a.username, a.password])], { bom: true })
    : null;

  res.status(201).json({
    message: `${added.length} ${added.length === 1 ? "person" : "people"} added`,
    added: added.length,
    invited,
    withPassword: withPassword.length,
    notAdded: failed.length,
    problemsCsv,
    passwordsCsv,
  });
}

// POST /users/disable { ids }: disable several people at once. Never
// yourself, never the last active admin. They're signed out everywhere.
export async function disableUsersHandler(req: Request, res: Response) {
  const me = currentUser(req);
  const ids = [...new Set(toIdList(req.body?.ids))];
  if (!ids.length) throw new HttpError(400, "Choose who to disable");
  if (ids.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} at a time`);

  let disabled = 0;
  const skipped: { id: string; name: string; reason: string }[] = [];
  for (const id of ids) {
    const person = await getUserById(id);
    if (!person) continue;
    const name = person.fullName || person.username;
    if (!person.isActive) continue; // already off
    if (id === me._id) {
      skipped.push({ id, name, reason: "You can't disable your own account" });
      continue;
    }
    if (person.role.isAdmin && (await countActiveAdmins(id)) === 0) {
      skipped.push({ id, name, reason: "At least one active admin is required" });
      continue;
    }
    await updateUser(id, { isActive: false });
    await deleteUserSessions(id);
    await audit(req, { action: "update", entity: "user", recordId: id, changes: { isActive: false } });
    disabled++;
  }
  res.json({ message: `${disabled} ${disabled === 1 ? "person" : "people"} disabled`, disabled, skipped });
}
