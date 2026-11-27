import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { readSqlDump, type SqlLogic, type SqlTable } from "./sqlDump.js";

// Bring your data (docs/WORKFLOW.md), part 1: read an Excel workbook (each
// sheet a table) or CSV files (each file a table), and work out a plan:
// tables, field types, and links between tables. Nothing is saved here; the
// admin reviews the plan first. The same reading is done again at import.

export type SourceFile = { name: string; buffer: Buffer };
// one sheet or CSV file: its header and data rows, every cell as text
export type Sheet = {
  file: number;
  sheet: string | null;
  source: string;
  header: string[];
  rows: string[][];
  // from a database dump: the table as the database defined it
  sql?: SqlTable;
};

export type PlanType = "text" | "textarea" | "number" | "date" | "boolean" | "choice" | "relation";
export type DateOrder = "dmy" | "mdy" | "ymd";

export type PlanColumn = {
  index: number; // position in the sheet
  source: string; // the header as in the file
  name: string; // the column's name in Zenin (snake_case)
  label: string;
  type: PlanType;
  include: boolean;
  options?: string[]; // a choice's options
  required?: boolean; // NOT NULL in the old database
  dateOrder?: DateOrder;
  link?: { table: string; by: number; match: number }; // relation: plan table key, its column index, % matched
  filled: number; // cells with a value
  unfit: number; // values that don't fit the type (listed as problems at import)
  samples: string[];
};
export type PlanTable = {
  key: string; // "0:Customers"
  file: number;
  sheet: string | null;
  source: string; // "Customers" (sheet) or "invoices.csv"
  tableName: string;
  include: boolean;
  rows: number;
  unique: number[]; // columns whose values are all different (can be linked to)
  columns: PlanColumn[];
};
// What Zenin has instead of the old system's logic (part 3)
export const ZENIN_EQUIVALENTS = ["formula", "total", "automation", "approval", "default", "required", "report", "none"] as const;
export type ZeninEquivalent = (typeof ZENIN_EQUIVALENTS)[number];
// a stored procedure, function, trigger or view of the old database
export type LogicItem = {
  kind: SqlLogic["kind"];
  name: string;
  sql: string;
  table?: string; // a trigger's table
  summary?: string; // what it does, in plain English (AI)
  zenin: ZeninEquivalent; // what to use in Zenin instead
  suggestion?: string; // how (AI)
  needsPerson: boolean;
  explained: boolean; // by the AI
};
export type Plan = { tables: PlanTable[]; logic?: LogicItem[] };

const MAX_SAMPLES = 3;
const MAX_CHOICES = 12;
const FIT = 0.9; // share of values that must fit a type (the odd typo goes to the problems file)
const LINK_MATCH = 0.9; // share of a column's values found in the other table

/* ---------------- reading ---------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// An Excel cell as text: dates as YYYY-MM-DD, formulas as their result
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((t) => t.text).join("").trim();
    if (typeof v.text === "string") return v.text.trim();
    if ("error" in v) return "";
  }
  return String(value).trim();
}

// Header names: blanks become "Column 3", repeats get a number
function cleanHeader(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} ${n}`;
    return name;
  });
}

// The first non-empty row is the header; empty rows are skipped
function toSheet(file: number, sheet: string | null, source: string, grid: string[][]): Sheet | null {
  const filled = grid.filter((r) => r.some((c) => c !== ""));
  if (filled.length < 1) return null;
  const width = Math.max(...filled.map((r) => r.length));
  const header = cleanHeader(Array.from({ length: width }, (_, i) => filled[0][i] ?? ""));
  const rows = filled.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { file, sheet, source, header, rows };
}

export async function readFiles(files: SourceFile[]): Promise<{ sheets: Sheet[]; logic: SqlLogic[] }> {
  const sheets: Sheet[] = [];
  const logic: SqlLogic[] = [];
  for (const [i, f] of files.entries()) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".xlsx")) {
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(f.buffer as unknown as ArrayBuffer);
      } catch {
        throw new Error(`"${f.name}" couldn't be read as an Excel file. Save it again as .xlsx and try again.`);
      }
      for (const ws of wb.worksheets) {
        const grid: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell, col) => {
            cells[col - 1] = cellText(cell.value);
          });
          grid.push(Array.from({ length: cells.length }, (_, k) => cells[k] ?? ""));
        });
        const sheet = toSheet(i, ws.name, ws.name, grid);
        if (sheet) sheets.push(sheet);
      }
    } else if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
      const text = f.buffer.toString("utf8");
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
      let grid: string[][];
      try {
        grid = parse(text, { delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
      } catch {
        throw new Error(`"${f.name}" couldn't be read as CSV. Save it again as CSV (UTF-8) and try again.`);
      }
      const sheet = toSheet(i, null, f.name.replace(/\.(csv|txt)$/i, ""), grid);
      if (sheet) sheets.push(sheet);
    } else if (lower.endsWith(".sql")) {
      // a database dump: tables, keys, links and rows, plus the logic to report on
      const dump = readSqlDump(f.buffer.toString("utf8"));
      if (!dump.tables.length && !dump.logic.length) throw new Error(`"${f.name}" has no CREATE TABLE in it. Export it as plain SQL (mysqldump, pg_dump --format=plain, or SQL Server "Generate Scripts" with data).`);
      for (const t of dump.tables) sheets.push({ file: i, sheet: t.name, source: t.name, header: t.columns.map((c) => c.name), rows: t.rows, sql: t });
      logic.push(...dump.logic);
    } else {
      throw new Error(`"${f.name}": only Excel (.xlsx), CSV and SQL dump (.sql) files can be read here`);
    }
  }
  return { sheets, logic };
}

/* ---------------- values ---------------- */

// "1,20,000.50", "₹ 1,200", "-45", "12%" -> number; null when it isn't one
export function parseNumber(raw: string): number | null {
  const s = raw.replace(/[₹$€£\s]/g, "").replace(/^rs\.?/i, "").replace(/%$/, "");
  if (!/^[-+]?(\d{1,3}(,\d{2,3})*|\d+)(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const validDate = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

// a date in many common forms -> YYYY-MM-DD; null when it isn't one
export function parseDate(raw: string, order: DateOrder = "dmy"): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) return order === "mdy" ? validDate(+m[3], +m[1], +m[2]) : validDate(+m[3], +m[2], +m[1]);
  // "3 Mar 2026", "03-March-2026"
  m = /^(\d{1,2})[\s-]([a-z]{3,9})[\s,-]+(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return validDate(+m[3], month, +m[1]);
  }
  // "Mar 3, 2026"
  m = /^([a-z]{3,9})\s(\d{1,2}),?\s(\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return validDate(+m[3], month, +m[2]);
  }
  return null;
}

// "t"/"f": how Postgres writes booleans in a dump
const TRUE = ["yes", "y", "true", "1", "active", "t"];
const FALSE = ["no", "n", "false", "0", "inactive", "f"];
export function parseBoolean(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  return TRUE.includes(s) ? true : FALSE.includes(s) ? false : null;
}

// "Invoice No." -> "invoice_no"; never empty, never starting with "_"
export function slug(text: string, fallback: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return s && /^[a-z]/.test(s) ? s : `${fallback}${s ? `_${s}` : ""}`.slice(0, 50);
}

/* ---------------- the plan ---------------- */

// Which way round are dates like 03/04/2026? Day first, unless the data shows month first.
function dateOrder(values: string[]): DateOrder {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}$/.exec(v.trim());
    if (!m) continue;
    if (+m[1] > 12) dayFirst++;
    if (+m[2] > 12) monthFirst++;
  }
  return monthFirst > 0 && dayFirst === 0 ? "mdy" : "dmy";
}

// Phone numbers, PIN codes, account numbers and IDs look like numbers but are
// never added up: text, by their header or by how the values look
const IDENTIFIER = /phone|mobile|\btel\b|whats\s*app|contact|pin\s*code|\bpin\b|\bzip\b|postal|aadhaa?r|\bpan\b|gstin|gst\s*(no|number)|ifsc|account|\bacc\b|\bcode\b|\bid\b|\bno\.?$|number$/i;
const looksLikeIdentifier = (source: string, filled: string[]) =>
  IDENTIFIER.test(source) || filled.some((v) => /^\+|^0\d/.test(v.trim()) || /^\d{10,}$/.test(v.replace(/[\s-]/g, "")));

function guessColumn(index: number, source: string, values: string[], rowCount: number): PlanColumn {
  const filled = values.filter((v) => v !== "");
  const share = (fit: (v: string) => boolean) => (filled.length ? filled.filter(fit).length / filled.length : 0);
  const base = { index, source, name: "", label: source.slice(0, 100), include: true, filled: filled.length, samples: [...new Set(filled)].slice(0, MAX_SAMPLES) };
  if (!filled.length) return { ...base, type: "text", unfit: 0 };

  const distinct = new Set(filled.map((v) => v.toLowerCase()));
  const order = dateOrder(filled);
  const tests: [PlanType, (v: string) => boolean][] = [
    ["boolean", (v) => parseBoolean(v) !== null],
    ["number", (v) => parseNumber(v) !== null],
    ["date", (v) => parseDate(v, order) !== null],
  ];
  for (const [type, fits] of tests) {
    const s = share(fits);
    // Yes/No only for words (a column of 0s and 1s is a number) and two values
    if (type === "boolean" && (distinct.size > 2 || filled.every((v) => parseNumber(v) !== null))) continue;
    if (type === "number" && looksLikeIdentifier(source, filled)) continue;
    if (s >= FIT) return { ...base, type, unfit: Math.round(filled.length * (1 - s)), ...(type === "date" ? { dateOrder: order } : {}) };
  }
  // a short list of values that repeat: a choice (Status, Category, City)
  const long = filled.some((v) => v.length > 40);
  if (!long && distinct.size <= MAX_CHOICES && distinct.size < filled.length / 2 && rowCount >= 4) {
    const options: string[] = [];
    for (const v of filled) if (!options.some((o) => o.toLowerCase() === v.toLowerCase())) options.push(v);
    return { ...base, type: "choice", unfit: 0, options };
  }
  const avg = filled.reduce((s, v) => s + v.length, 0) / filled.length;
  return { ...base, type: avg > 80 || filled.some((v) => v.includes("\n")) ? "textarea" : "text", unfit: 0 };
}

const norm = (v: string) => v.trim().toLowerCase();

// "customer_id" -> "Customer", "placed_at" -> "Placed at"
const humanize = (name: string, link: boolean) => {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").trim();
  const base = link ? words.replace(/\s+id$/i, "") || words : words;
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
};

// A database column's type in Zenin, from its SQL type (the values only help
// with text columns: a short repeating list becomes a choice)
function sqlColumn(index: number, sheet: Sheet, isKey: boolean, isLink: boolean): PlanColumn {
  const col = sheet.sql!.columns[index];
  const values = sheet.rows.map((r) => r[index] ?? "");
  const guess = guessColumn(index, col.name, values, sheet.rows.length);
  const t = col.sqlType.toLowerCase();
  let type: PlanType;
  if (col.enumValues?.length) type = "choice";
  else if (isLink) type = "relation";
  else if (/^(bool|boolean|bit\b|bit\s*\(\s*1\s*\)|tinyint\s*\(\s*1\s*\))/.test(t)) type = "boolean";
  else if (/int|serial|decimal|numeric|float|double|real|money|^number/.test(t)) type = isKey || looksLikeIdentifier(col.name, values.filter(Boolean)) ? "text" : "number";
  else if (/^(date|datetime|datetime2|smalldatetime|timestamp)/.test(t)) type = "date";
  else if (/text|clob|json|xml/.test(t)) type = "textarea";
  else if (!t) type = guess.type;
  else type = guess.type === "choice" || guess.type === "textarea" ? guess.type : "text";
  const base: PlanColumn = { ...guess, type, label: humanize(col.name, isLink), required: col.notNull && !col.autoIncrement && !isKey };
  const out = type === "relation" ? base : restatColumn(base, values);
  // an enum's options are all its values, used or not
  if (col.enumValues?.length) out.options = [...new Set([...col.enumValues, ...(out.options ?? [])])];
  return out;
}

export function makePlan(sheets: Sheet[], takenTables: Set<string>, logic: SqlLogic[] = []): Plan {
  const usedTables = new Set([...takenTables].map((t) => t.toLowerCase()));
  const tables: PlanTable[] = sheets.map((s, i) => {
    let tableName = slug(s.source, "table");
    for (let n = 2; usedTables.has(tableName); n++) tableName = `${slug(s.source, "table").slice(0, 46)}_${n}`;
    usedTables.add(tableName);
    const usedCols = new Set<string>();
    const sqlIndex = (name: string) => s.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const key = s.sql?.primaryKey.length === 1 ? sqlIndex(s.sql.primaryKey[0]) : -1;
    const columns = s.header.map((h, c) => {
      const isLink = Boolean(s.sql?.foreignKeys.some((f) => f.column.toLowerCase() === h.toLowerCase()));
      const col = s.sql ? sqlColumn(c, s, c === key, isLink) : guessColumn(c, h, s.rows.map((r) => r[c] ?? ""), s.rows.length);
      let name = slug(h, "column");
      for (let n = 2; usedCols.has(name); n++) name = `${slug(h, "column").slice(0, 46)}_${n}`;
      usedCols.add(name);
      // a database's own numbering (id 1, 2, 3…) isn't needed in Zenin; links still use it
      const surrogate = c === key && Boolean(s.sql?.columns[c]?.autoIncrement || /^id$/i.test(h));
      return { ...col, name, include: !surrogate };
    });
    // columns that identify a row: a dump says which; otherwise every value present and different
    const unique = s.sql
      ? [...(key >= 0 ? [key] : []), ...s.sql.unique.filter((u) => u.length === 1).map((u) => sqlIndex(u[0])).filter((x) => x >= 0 && x !== key)]
      : columns
          .filter((c) => c.filled === s.rows.length && c.filled > 0 && new Set(s.rows.map((r) => norm(r[c.index] ?? ""))).size === c.filled)
          .map((c) => c.index);
    return { key: `${i}:${s.source}`, file: s.file, sheet: s.sheet, source: s.source, tableName, include: true, rows: s.rows.length, unique, columns };
  });

  const valuesOf = (t: number, c: number) => new Set(sheets[t].rows.map((r) => norm(r[c] ?? "")).filter(Boolean));
  const matchOf = (ti: number, ci: number, ui: number, by: number) => {
    const mine = valuesOf(ti, ci);
    const theirs = valuesOf(ui, by);
    let hits = 0;
    for (const v of mine) if (theirs.has(v)) hits++;
    return { match: mine.size ? hits / mine.size : 1, size: mine.size };
  };
  const edges: [number, number][] = [];
  const reaches = (from: number, to: number): boolean =>
    from === to || edges.some(([a, b]) => a === from && reaches(b, to));
  const setLink = (ti: number, col: PlanColumn, ui: number, by: number) => {
    const { match, size } = matchOf(ti, col.index, ui, by);
    edges.push([ti, ui]);
    col.type = "relation";
    delete col.options;
    col.link = { table: tables[ui].key, by, match: Math.round(match * 100) };
    col.unfit = Math.round(size * (1 - match));
  };
  for (const [ti, t] of tables.entries()) {
    const sql = sheets[ti].sql;
    for (const col of t.columns) {
      // a dump says exactly what links where (a link to itself, or a loop, stays text)
      if (sql) {
        const fk = sql.foreignKeys.find((f) => f.column.toLowerCase() === col.source.toLowerCase());
        if (!fk) continue;
        const ui = tables.findIndex((u, k) => sheets[k].sql && u.source.toLowerCase() === fk.refTable.toLowerCase());
        const by = ui >= 0 ? sheets[ui].header.findIndex((h) => h.toLowerCase() === fk.refColumn.toLowerCase()) : -1;
        if (ui >= 0 && ui !== ti && by >= 0 && !reaches(ui, ti)) setLink(ti, col, ui, by);
        else if (col.type === "relation") Object.assign(col, restatColumn({ ...col, type: "text" }, sheets[ti].rows.map((r) => r[col.index] ?? "")));
        continue;
      }
      // the table's own key (its first identifying column) isn't a link
      if (!col.filled || t.unique[0] === col.index || col.type === "boolean" || col.type === "date") continue;
      let best: { table: number; by: number; match: number } | null = null;
      for (const [ui, u] of tables.entries()) {
        if (ui === ti) continue;
        for (const by of u.unique) {
          const { match, size } = matchOf(ti, col.index, ui, by);
          if (size && match >= LINK_MATCH && (!best || match > best.match)) best = { table: ui, by, match };
        }
      }
      // no loops between tables (A links to B and B to A)
      if (best && !reaches(best.table, ti)) setLink(ti, col, best.table, best.by);
    }
  }
  return { tables, ...(logic.length ? { logic: logic.map(firstGuess) } : {}) };
}

// Before any AI: what each kind of logic usually becomes in Zenin
function firstGuess(l: SqlLogic): LogicItem {
  const table = l.kind === "trigger" ? /\bON\s+([^\s(]+)/i.exec(l.sql)?.[1]?.split(".").pop()?.replace(/[`"[\]]/g, "") : undefined;
  const zenin: ZeninEquivalent = l.kind === "trigger" ? "automation" : l.kind === "view" ? "report" : "none";
  return { kind: l.kind, name: l.name, sql: l.sql, ...(table ? { table } : {}), zenin, needsPerson: true, explained: false };
}

// Tables in an order where linked-to tables come first
export function importOrder(plan: Plan): PlanTable[] {
  const included = plan.tables.filter((t) => t.include);
  const done: PlanTable[] = [];
  const visit = (t: PlanTable, seen: Set<string>) => {
    if (done.includes(t) || seen.has(t.key)) return;
    seen.add(t.key);
    for (const c of t.columns) {
      if (!c.include || c.type !== "relation" || !c.link) continue;
      const target = included.find((x) => x.key === c.link!.table);
      if (target) visit(target, seen);
    }
    done.push(t);
  };
  for (const t of included) visit(t, new Set());
  return done;
}

// After the admin changes a column's type in the review: count again what
// fits, and a choice's options. Throws when a choice would have too many.
export const MAX_CHOICE_OPTIONS = 50;
export function restatColumn(col: PlanColumn, values: string[]): PlanColumn {
  const filled = values.filter((v) => v !== "");
  const unfitOf = (fits: (v: string) => boolean) => filled.filter((v) => !fits(v)).length;
  const next: PlanColumn = { ...col, filled: filled.length };
  delete next.options;
  if (col.type !== "relation") delete next.link;
  if (col.type === "date") next.dateOrder = col.dateOrder ?? dateOrder(filled);
  switch (col.type) {
    case "number":
      next.unfit = unfitOf((v) => parseNumber(v) !== null);
      break;
    case "date":
      next.unfit = unfitOf((v) => parseDate(v, next.dateOrder) !== null);
      break;
    case "boolean":
      next.unfit = unfitOf((v) => parseBoolean(v) !== null);
      break;
    case "choice": {
      const options: string[] = [];
      for (const v of filled) if (!options.some((o) => o.toLowerCase() === v.toLowerCase())) options.push(v.slice(0, 100));
      if (options.length > MAX_CHOICE_OPTIONS) throw new Error(`"${col.label}" has ${options.length} different values: too many for a choice (at most ${MAX_CHOICE_OPTIONS}). Keep it as text.`);
      next.options = options;
      next.unfit = 0;
      break;
    }
    case "relation":
      break; // links stay as found
    default:
      next.unfit = 0;
  }
  return next;
}
