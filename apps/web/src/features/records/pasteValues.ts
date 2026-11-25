import { getDepartmentOptions, getRelationOptions, getUserOptions } from "../../api/api";
import type { RecordColumn } from "./schema";

// Pasting into the Spreadsheet view: text copied from Excel or Google Sheets
// (tab between cells, a new line between rows) becomes values a field takes.
// The server checks every value again, exactly as for a normal save.

// "a\tb\n1\t2" -> [["a","b"],["1","2"]]. Quoted cells ("x\ny") keep their tabs
// and new lines; a trailing empty line (Excel adds one) is dropped.
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

const pad = (n: number) => String(n).padStart(2, "0");

// a date as typed or copied: 2026-11-25, 25/11/2026, 25-11-2026 (day first, as in India)
function toDate(text: string): string | null {
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;
  const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3];
    const [d, m] = [+dmy[1], +dmy[2]];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${year}-${pad(m)}-${pad(d)}`;
  }
  return null;
}

export class PasteProblem extends Error {}

// names already looked up, per field ("Ann" -> id), so 50 rows of "Ann" ask once
type Cache = Map<string, Map<string, string | null>>;
export const newLookupCache = (): Cache => new Map();

async function lookUp(column: RecordColumn, label: string, cache: Cache): Promise<string> {
  const key = `${column.type}:${column.ref ?? ""}`;
  const known = cache.get(key) ?? new Map<string, string | null>();
  cache.set(key, known);
  const wanted = label.trim().toLowerCase();
  if (!known.has(wanted)) {
    let options: { value: string; label: string }[] = [];
    if (column.type === "user") options = (await getUserOptions({ search: label.trim(), limit: 20 })).data;
    else if (column.type === "department") options = (await getDepartmentOptions()).data;
    else if (column.ref) options = (await getRelationOptions(column.ref, { search: label.trim(), limit: 20, displayField: column.displayField })).data;
    const match = options.filter((o) => o.label.trim().toLowerCase() === wanted);
    known.set(wanted, match.length === 1 ? match[0].value : null);
  }
  const id = known.get(wanted);
  if (!id) throw new PasteProblem(`No "${label.trim()}" to pick in ${column.label || column.name}`);
  return id;
}

// The value a field takes for pasted text (empty text clears it).
export async function pastedValue(column: RecordColumn, text: string, cache: Cache): Promise<unknown> {
  const t = text.trim();
  const multiple = Boolean(column.multiple);
  if (t === "") return multiple ? [] : null;
  switch (column.type) {
    case "number": {
      const n = Number(t.replace(/[,\s₹$]/g, ""));
      if (Number.isNaN(n)) throw new PasteProblem(`"${t}" isn't a number`);
      return n;
    }
    case "date": {
      const d = toDate(t);
      if (!d) throw new PasteProblem(`"${t}" isn't a date`);
      return d;
    }
    case "boolean": {
      if (/^(yes|y|true|1|✓|✔|x)$/i.test(t)) return true;
      if (/^(no|n|false|0)$/i.test(t)) return false;
      throw new PasteProblem(`"${t}" isn't yes or no`);
    }
    case "choice": {
      const find = (label: string) => {
        const o = (column.options ?? []).find((x) => x.label.toLowerCase() === label.trim().toLowerCase());
        if (!o) throw new PasteProblem(`"${label.trim()}" isn't an option of ${column.label || column.name}`);
        return o.label;
      };
      return multiple ? t.split(/[,;]/).filter((x) => x.trim()).map(find) : find(t);
    }
    case "user":
    case "department":
    case "relation":
      if (multiple) {
        const out: string[] = [];
        for (const part of t.split(/[,;]/).filter((x) => x.trim())) out.push(await lookUp(column, part, cache));
        return out;
      }
      return lookUp(column, t, cache);
    default:
      return text;
  }
}
