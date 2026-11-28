import { Readable } from "node:stream";
import { stringify } from "csv-stringify/sync";
import { loadDraftedApps } from "../apps/draft.js";
import { uninstall } from "../apps/installer.js";
import { createOwnApp, ensureMyTables, placeNewTable } from "../apps/ownApps.js";
import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { insertRecords } from "../repo/recordRepo.js";
import { audit } from "../repo/auditRepo.js";
import { setProgress, type Job, type JobResult } from "../repo/jobRepo.js";
import { createTable, deleteTable, getSchema } from "../schema/schemaRepo.js";
import { storage } from "../storage.js";
import type { RecordData } from "../types.js";
import { importOrder, parseBoolean, parseDate, parseNumber, readFiles, type Plan, type PlanColumn, type PlanTable, type Sheet } from "./analyze.js";
import { getMigration, updateMigration, type MigrationResult, type TableProof } from "./store.js";
import { findRules } from "./rules.js";

// Bring your data: the background import of a reviewed plan (job type
// "migration"). It makes a new app with one table per planned table, imports
// every row (a value that doesn't fit is left empty and listed, the row is
// always imported), links rows between tables, and checks the result: rows
// and number totals in the file against Zenin. If anything fails, everything
// it made is removed again, so there's never half an import.

const BATCH = 500;
type Problem = { table: string; line: number; column: string; value: string; problem: string };

const streamToBuffer = async (body: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
};

export async function readStoredFiles(keys: string[], names: string[]) {
  const files = [];
  for (const [i, key] of keys.entries()) files.push({ name: names[i] ?? key, buffer: await streamToBuffer((await storage.get(key)).body) });
  return files;
}

const sheetFor = (sheets: Sheet[], t: PlanTable) => sheets.find((s) => s.file === t.file && s.sheet === t.sheet && s.source === t.source);
const norm = (v: string) => v.trim().toLowerCase();

// The column definitions Zenin keeps for a planned table
function columnsFor(t: PlanTable, plan: Plan) {
  return t.columns
    .filter((c) => c.include)
    .map((c) => {
      const base = { name: c.name, label: c.label || c.source, ...(c.required ? { required: true } : {}) };
      if (c.type === "choice") return { ...base, type: "choice", options: (c.options ?? []).map((label) => ({ label })) };
      if (c.type === "relation") {
        const target = plan.tables.find((x) => x.key === c.link?.table && x.include);
        // a link to a table left out: kept as text
        return target ? { ...base, type: "relation", ref: target.tableName } : { ...base, type: "text" };
      }
      return { ...base, type: c.type };
    });
}

// One cell's stored value, or a problem
function valueOf(c: PlanColumn, raw: string, targets: Map<string, Map<string, string>>, plan: Plan): { value?: unknown; problem?: string } {
  if (raw === "") return {};
  switch (c.type) {
    case "number": {
      const n = parseNumber(raw);
      return n === null ? { problem: "Not a number" } : { value: n };
    }
    case "date": {
      const d = parseDate(raw, c.dateOrder ?? "dmy");
      return d === null ? { problem: "Not a date" } : { value: d };
    }
    case "boolean": {
      const b = parseBoolean(raw);
      return b === null ? { problem: "Not Yes or No" } : { value: b };
    }
    case "choice": {
      const option = (c.options ?? []).find((o) => o.toLowerCase() === raw.toLowerCase());
      return option ? { value: option } : { problem: "Not one of the options" };
    }
    case "relation": {
      const target = plan.tables.find((x) => x.key === c.link?.table && x.include);
      if (!target) return { value: raw };
      const id = targets.get(`${target.key}#${c.link!.by}`)?.get(norm(raw));
      return id ? { value: id } : { problem: `No matching record in ${target.tableName}` };
    }
    default:
      return { value: raw };
  }
}

export async function runMigration(job: Job): Promise<{ result: JobResult }> {
  const id = String(job.params.migrationId ?? "");
  const migration = await getMigration(id);
  if (!migration) throw new Error("That import no longer exists");
  const plan = migration.plan;
  const order = importOrder(plan);
  const created: string[] = [];
  let appKey: string | null = null;

  try {
    const { sheets } = await readFiles(await readStoredFiles(migration.fileKeys, migration.fileNames));
    // 1. the app, named after the file ("Clinic data"), and its tables
    await loadDraftedApps();
    const base = migration.name.replace(/\.(xlsx|csv|txt)$/i, "").replace(/·/g, "-").slice(0, 34) || "Imported data";
    for (let n = 1; !appKey; n++) {
      try {
        appKey = (await createOwnApp({ name: n === 1 ? base : `${base} ${n}`, icon: "IconClipboardList" }, job.userId)).key;
      } catch (e) {
        if (n > 20 || !/already an app/.test((e as Error).message)) throw e;
      }
    }
    for (const t of order) {
      await createTable({ tableName: t.tableName, columns: columnsFor(t, plan), byDepartment: false });
      created.push(t.tableName);
      await placeNewTable(t.tableName, appKey, "none");
    }

    // 2. the rows, linked-to tables first
    const targets = new Map<string, Map<string, string>>(); // "tableKey#columnIndex" -> value -> record id
    const linkedBy = new Set(plan.tables.flatMap((t) => t.columns.filter((c) => c.include && c.type === "relation" && c.link).map((c) => `${c.link!.table}#${c.link!.by}`)));
    const problems: Problem[] = [];
    const proof: TableProof[] = [];
    const totalRows = order.reduce((s, t) => s + (sheetFor(sheets, t)?.rows.length ?? 0), 0) || 1;
    let done = 0;
    for (const t of order) {
      const sheet = sheetFor(sheets, t);
      if (!sheet) throw new Error(`"${t.source}" isn't in the uploaded files any more`);
      const cols = t.columns.filter((c) => c.include);
      const fileTotals = new Map<string, number>();
      const ids: string[] = [];
      let tableProblems = 0;
      for (let start = 0; start < sheet.rows.length; start += BATCH) {
        const batch = sheet.rows.slice(start, start + BATCH);
        const records = batch.map((row, k) => {
          const data: RecordData = {};
          for (const c of cols) {
            const raw = (row[c.index] ?? "").trim();
            const { value, problem } = valueOf(c, raw, targets, plan);
            if (problem) {
              problems.push({ table: t.tableName, line: start + k + 2, column: c.label || c.source, value: raw, problem });
              tableProblems++;
            } else if (value !== undefined) {
              data[c.name] = value;
              if (c.type === "number") fileTotals.set(c.name, (fileTotals.get(c.name) ?? 0) + (value as number));
            }
          }
          return { data, departmentId: null };
        });
        ids.push(...(await insertRecords(t.tableName, records, job.userId)));
        done += batch.length;
        await setProgress(job._id, Math.min(99, Math.round((done / totalRows) * 100)));
      }
      // values of identifying columns -> the new record ids, for the tables that link here
      for (const c of t.columns) {
        const key = `${t.key}#${c.index}`;
        if (!linkedBy.has(key)) continue;
        targets.set(key, new Map(sheet.rows.map((r, i) => [norm(r[c.index] ?? ""), ids[i]] as [string, string]).filter(([v]) => v)));
      }
      // 3. the proof: rows and totals, counted again in the database
      const { rows: counted } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${dataTable(t.tableName)}`);
      const totals = [];
      for (const c of cols.filter((x) => x.type === "number")) {
        const { rows } = await query<{ s: string | null }>(`SELECT sum((data ->> ${quoteLiteral(c.name)})::numeric) AS s FROM ${dataTable(t.tableName)}`);
        const zenin = Number(rows[0].s ?? 0);
        const file = Math.round((fileTotals.get(c.name) ?? 0) * 100) / 100;
        totals.push({ column: c.name, label: c.label || c.source, file, zenin: Math.round(zenin * 100) / 100, match: Math.abs(file - zenin) < 0.005 });
      }
      proof.push({ table: t.tableName, source: t.source, rowsInFile: sheet.rows.length, imported: counted[0].n, totals, problems: tableProblems });
    }

    // the values that didn't fit, as a file to look through
    let problemsKey: string | null = null;
    if (problems.length) {
      problemsKey = `migrations/${id}/problems.csv`;
      const csv = stringify([["Table", "Row in file", "Column", "Value", "Problem"], ...problems.map((p) => [p.table, p.line, p.column, p.value, p.problem])], { bom: true });
      await storage.put(problemsKey, Buffer.from(csv), "text/csv");
    }
    const result: MigrationResult = {
      tables: proof,
      problems: problems.length,
      allMatch: proof.every((p) => p.rowsInFile === p.imported && p.totals.every((x) => x.match)),
    };
    // the old system's calculations, found in the data (part 4); never fails the import
    const rules = await findRules(created).catch(() => null);
    await updateMigration(id, { status: "done", appKey, createdTables: created, result, rules, problemsKey, error: null });
    await audit(null, {
      userId: job.userId,
      username: job.username,
      action: "import",
      entity: "app",
      recordId: appKey!,
      changes: { migration: { to: migration.name }, tables: { to: created }, rows: { to: proof.reduce((s, p) => s + p.imported, 0) } },
    });
    return { result: { rows: totalRows, inserted: proof.reduce((s, p) => s + p.imported, 0), failed: problems.length } };
  } catch (error) {
    // never half an import: take away what was made
    await removeImported(created, appKey).catch(() => {});
    await updateMigration(id, { status: "failed", error: (error as Error).message || "The import failed", createdTables: [], appKey: null });
    throw error;
  }
}

// Delete an import's tables (with their records) and its app.
export async function removeImported(tables: string[], appKey: string | null) {
  for (const name of [...tables].reverse()) {
    const schema = await getSchema(name);
    if (schema) await deleteTable(schema, []);
  }
  if (appKey) {
    await loadDraftedApps();
    await uninstall(appKey).catch(() => {});
    await ensureMyTables();
  }
}
