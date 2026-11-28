import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import { valueType } from "../schema/columns.js";
import { asComputed, changeBack, checkConversion, conversions, convertColumn, prove, type Computed } from "../schema/convert.js";
import { computedSql } from "../schema/formula.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { Column, RollupConfig, TableSchema } from "../types.js";

// Bring your data, part 4 (docs/WORKFLOW.md): the calculations the old
// system did, found in the imported data itself. "Amount = Qty × Price",
// "Tax = 18% of Subtotal", "Due date = Invoice date + 30 days", "Total = the
// sum of its lines' Amount".
//
// No AI: Zenin guesses on a sample of records (fast, in memory), then proves
// each guess on every record with the formula engine's own SQL, the same
// code that works the value out once the rule is in use. Nothing leaves the
// server. A rule must fit FIT of the records that have its fields; the
// simplest rule wins, and rules never feed each other in a circle.

export type Rule = {
  id: string; // "table.column": at most one rule per field
  table: string;
  column: string;
  // the field's type when found ("number", "date", "text"): it must still be that to use it
  type: string;
  kind: "formula" | "total";
  expression?: string;
  rollup?: RollupConfig;
  says: string; // "Amount = Qty × Price"
  hint?: string; // "18% of Subtotal", "rounded to 2 decimals"
  // on every record, when found
  checked: number; // records with a value
  fits: number;
  differ: number;
  fills: number; // empty now; the rule would fill them
  // in use now: worked out by Zenin (shownRules)
  used: boolean;
};

const FIT = 0.98;
const MIN_ROWS = 10;
const SAMPLE = 2_000;
const MAX_INPUTS = 25;
const MAX_RULES = 40;
const DAY = 86_400_000;

const label = (c: Column) => c.label || c.name;
const title = (name: string) => {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown): number | null => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : null;
};
const txt = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
// equal but for floating-point noise (the database then checks it exactly)
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const roundTo = (v: number, d: number) => {
  const f = 10 ** d;
  return (Math.sign(v) * Math.round(Math.abs(v) * f + 1e-7)) / f;
};
// decimals the field is written with (at most 4): the old system's rounding
const decimalsOf = (values: (number | null)[]) =>
  Math.min(4, Math.max(0, ...values.map((v) => (v === null ? 0 : (/\.(\d+)$/.exec(String(v))?.[1].length ?? 0)))));
const distinct = (values: unknown[]) => new Set(values.filter((v) => v !== null)).size;
const nice = (k: number) => String(Number(k.toFixed(6)));

/* ---------------- guessing, on a sample ---------------- */

type Candidate = {
  table: string;
  target: string;
  position: number; // the field's place in the table (later fields are usually the results)
  kind: "formula" | "total";
  expression?: string;
  rollup?: RollupConfig;
  inputs: string[]; // "table.column" it's worked out from
  cost: number; // simpler first
  says: string;
  hint?: string;
};

// Does `same(i)` hold on enough rows? `same` gives null for rows that can't
// tell (the target or an input empty). Stops as soon as too many miss.
function holds(count: number, filled: number, same: (i: number) => boolean | null): boolean {
  const allowed = Math.floor(filled * (1 - FIT));
  let seen = 0;
  let miss = 0;
  for (let i = 0; i < count; i++) {
    const r = same(i);
    if (r === null) continue;
    seen++;
    if (!r && ++miss > allowed) return false;
  }
  return seen >= MIN_ROWS && miss <= Math.floor(seen * (1 - FIT));
}

// A number rule: exactly, or once rounded like the field (null: neither)
function numberFit(target: (number | null)[], places: number, f: (i: number) => number | null): "exact" | "round" | null {
  const filled = target.filter((v) => v !== null).length;
  if (filled < MIN_ROWS) return null;
  const test = (rounded: boolean) =>
    holds(target.length, filled, (i) => {
      const t = target[i];
      if (t === null) return null;
      const v = f(i);
      if (v === null) return null;
      return Number.isFinite(v) && close(t, rounded ? roundTo(v, places) : v);
    });
  return test(false) ? "exact" : test(true) ? "round" : null;
}

// the median of target / x: the fixed rate, if there is one
function factor(target: (number | null)[], x: (i: number) => number | null): number | null {
  const ratios: number[] = [];
  for (let i = 0; i < target.length; i++) {
    const t = target[i];
    const v = x(i);
    if (t !== null && v !== null && v !== 0) ratios.push(t / v);
  }
  if (ratios.length < MIN_ROWS) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

// "18% of Amount", "Amount plus 18%"
function rateHint(k: number, of: string): string | undefined {
  // a percentage with at most 2 decimals (18, 12.5), or none
  const pct = (v: number) => {
    const p = Number((v * 100).toFixed(6));
    return Number.isInteger(Math.round(p * 100 * 1e6) / 1e6) ? p : null;
  };
  if (k > 0 && k < 1 && pct(k) !== null) return `${pct(k)}% of ${of}`;
  if (k > 1 && k < 2 && pct(k - 1) !== null) return `${of} plus ${pct(k - 1)}%`;
  return undefined;
}

type Sample = { _id: string; data: Record<string, unknown> }[];

function formulaCandidates(schema: TableSchema, rows: Sample): Candidate[] {
  const out: Candidate[] = [];
  const cols = schema.columns;
  const position = (c: Column) => cols.indexOf(c);
  const N = new Map(cols.map((c) => [c.name, rows.map((r) => num(r.data[c.name]))]));
  const D = new Map(cols.map((c) => [c.name, rows.map((r) => day(r.data[c.name]))]));
  const S = new Map(cols.map((c) => [c.name, rows.map((r) => txt(r.data[c.name]))]));
  const varies = (values: unknown[]) => distinct(values) >= 3;
  const numbers = cols.filter((c) => valueType(c) === "number" && varies(N.get(c.name)!)).slice(0, MAX_INPUTS);
  const dates = cols.filter((c) => valueType(c) === "date" && varies(D.get(c.name)!)).slice(0, MAX_INPUTS);
  // text, and single choices as parts of it (a Last name with few values became a choice)
  const texts = cols.filter((c) => (c.type === "text" || (c.type === "choice" && !c.multiple)) && varies(S.get(c.name)!)).slice(0, MAX_INPUTS);
  const ref = (c: Column) => `{${c.name}}`;
  const dep = (...cs: Column[]) => cs.map((c) => `${schema.tableName}.${c.name}`);

  // numbers
  for (const T of numbers.filter((c) => c.type === "number")) {
    const t = N.get(T.name)!;
    const places = decimalsOf(t);
    const ins = numbers.filter((c) => c !== T);
    const found: Candidate[] = [];
    const add = (expr: string, says: string, inputs: Column[], cost: number, f: (i: number) => number | null, hint?: string) => {
      const fit = numberFit(t, places, f);
      if (!fit) return false;
      const rounded = fit === "round";
      found.push({
        table: schema.tableName,
        target: T.name,
        position: position(T),
        kind: "formula",
        expression: rounded ? `ROUND(${expr}, ${places})` : expr,
        inputs: dep(...inputs),
        cost: cost + (rounded ? 0.5 : 0),
        says: `${label(T)} = ${says}`,
        hint: [hint, rounded ? (places ? `rounded to ${places} decimal${places === 1 ? "" : "s"}` : "rounded to whole numbers") : ""].filter(Boolean).join(", ") || undefined,
      });
      return true;
    };
    const v = (c: Column) => N.get(c.name)!;
    // a field that's just a copy of another isn't a rule
    if (ins.some((a) => numberFit(t, places, (i) => v(a)[i]) === "exact")) continue;

    for (let x = 0; x < ins.length; x++) {
      const A = ins[x];
      const a = v(A);
      for (let y = x + 1; y < ins.length; y++) {
        const B = ins[y];
        const b = v(B);
        const both = (g: (p: number, q: number) => number) => (i: number) => (a[i] === null || b[i] === null ? null : g(a[i]!, b[i]!));
        add(`${ref(A)} * ${ref(B)}`, `${label(A)} × ${label(B)}`, [A, B], 1, both((p, q) => p * q));
        add(`${ref(A)} + ${ref(B)}`, `${label(A)} + ${label(B)}`, [A, B], 1, both((p, q) => p + q));
      }
      for (const B of ins) {
        if (B === A) continue;
        const b = v(B);
        const both = (g: (p: number, q: number) => number) => (i: number) => (a[i] === null || b[i] === null ? null : g(a[i]!, b[i]!));
        add(`${ref(A)} - ${ref(B)}`, `${label(A)} − ${label(B)}`, [A, B], 3, both((p, q) => p - q));
        add(`${ref(A)} / ${ref(B)}`, `${label(A)} ÷ ${label(B)}`, [A, B], 5, both((p, q) => (q === 0 ? NaN : p / q)));
      }
      // a fixed rate: Tax = Subtotal × 0.18
      const k = factor(t, (i) => a[i]);
      if (k !== null) {
        for (let d = 2; d <= 6; d++) {
          const kk = roundTo(k, d);
          if (kk === 0 || close(kk, 1)) break;
          if (add(`${ref(A)} * ${nice(kk)}`, `${label(A)} × ${nice(kk)}`, [A], 2 + d * 0.1, (i) => (a[i] === null ? null : a[i]! * kk), rateHint(kk, label(A)))) break;
        }
      }
    }
    // days between two dates: Nights = DAYS(Check out, Check in)
    for (const A of dates) {
      for (const B of dates) {
        if (A === B) continue;
        const a = D.get(A.name)!;
        const b = D.get(B.name)!;
        const gap = (i: number) => (a[i] === null || b[i] === null ? null : a[i]! - b[i]!);
        add(`DAYS(${ref(A)}, ${ref(B)})`, `days from ${label(B)} to ${label(A)}`, [A, B], 2, gap);
        add(`DAYS(${ref(A)}, ${ref(B)}) + 1`, `days from ${label(B)} to ${label(A)}, counting both`, [A, B], 2.5, (i) => {
          const g = gap(i);
          return g === null ? null : g + 1;
        });
      }
    }
    // nothing simple: three fields
    if (!found.length) {
      for (let x = 0; x < ins.length; x++) {
        const A = ins[x];
        const a = v(A);
        for (let y = x + 1; y < ins.length; y++) {
          const B = ins[y];
          const b = v(B);
          const ab = (i: number) => (a[i] === null || b[i] === null ? null : a[i]! * b[i]!);
          // a rate on a product: Tax = Qty × Price × 0.18
          const k = factor(t, ab);
          if (k !== null) {
            for (let d = 2; d <= 6; d++) {
              const kk = roundTo(k, d);
              if (kk === 0 || close(kk, 1)) break;
              const said = kk === 0.01 ? `${label(A)} × ${label(B)} ÷ 100` : `${label(A)} × ${label(B)} × ${nice(kk)}`;
              const expr = kk === 0.01 ? `${ref(A)} * ${ref(B)} / 100` : `${ref(A)} * ${ref(B)} * ${nice(kk)}`;
              const f = (i: number) => {
                const p = ab(i);
                return p === null ? null : p * kk;
              };
              if (add(expr, said, [A, B], 3 + d * 0.1, f, kk === 0.01 ? "a percentage" : undefined)) break;
            }
          }
          for (const C of ins) {
            if (C === A || C === B) continue;
            const c = v(C);
            const three = (g: (p: number, q: number, r: number) => number) => (i: number) =>
              a[i] === null || b[i] === null || c[i] === null ? null : g(a[i]!, b[i]!, c[i]!);
            add(`${ref(A)} * ${ref(B)} - ${ref(C)}`, `${label(A)} × ${label(B)} − ${label(C)}`, [A, B, C], 3, three((p, q, r) => p * q - r));
            add(`${ref(A)} * ${ref(B)} + ${ref(C)}`, `${label(A)} × ${label(B)} + ${label(C)}`, [A, B, C], 3, three((p, q, r) => p * q + r));
            add(`${ref(A)} + ${ref(B)} - ${ref(C)}`, `${label(A)} + ${label(B)} − ${label(C)}`, [A, B, C], 4, three((p, q, r) => p + q - r));
            if (ins.indexOf(C) > y) {
              add(`${ref(A)} + ${ref(B)} + ${ref(C)}`, `${label(A)} + ${label(B)} + ${label(C)}`, [A, B, C], 3, three((p, q, r) => p + q + r));
            }
          }
        }
        // A − B − C
        for (let y = 0; y < ins.length; y++) {
          for (let z = y + 1; z < ins.length; z++) {
            const [B, C] = [ins[y], ins[z]];
            if (B === A || C === A) continue;
            const [b, c] = [v(B), v(C)];
            add(`${ref(A)} - ${ref(B)} - ${ref(C)}`, `${label(A)} − ${label(B)} − ${label(C)}`, [A, B, C], 4, (i) =>
              a[i] === null || b[i] === null || c[i] === null ? null : a[i]! - b[i]! - c[i]!
            );
          }
        }
      }
    }
    out.push(...found);
  }

  // dates: Due date = Invoice date + 30 days, or + a field (Credit days)
  for (const T of dates.filter((c) => c.type === "date")) {
    const t = D.get(T.name)!;
    const filled = t.filter((x) => x !== null).length;
    if (filled < MIN_ROWS) continue;
    const push = (expr: string, says: string, inputs: Column[], cost: number) =>
      out.push({ table: schema.tableName, target: T.name, position: position(T), kind: "formula", expression: expr, inputs: dep(...inputs), cost, says: `${label(T)} = ${says}` });
    for (const A of dates) {
      if (A === T) continue;
      const a = D.get(A.name)!;
      const gaps = new Map<number, number>();
      for (let i = 0; i < t.length; i++) if (t[i] !== null && a[i] !== null) gaps.set(t[i]! - a[i]!, (gaps.get(t[i]! - a[i]!) ?? 0) + 1);
      const k = [...gaps.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
      if (k !== undefined && k !== 0 && holds(t.length, filled, (i) => (t[i] === null || a[i] === null ? null : t[i]! - a[i]! === k))) {
        push(`ADD_DAYS(${ref(A)}, ${k})`, `${label(A)} ${k > 0 ? "+" : "−"} ${Math.abs(k)} day${Math.abs(k) === 1 ? "" : "s"}`, [A], 2);
      }
      for (const n of numbers) {
        const nv = N.get(n.name)!;
        if (holds(t.length, filled, (i) => (t[i] === null || a[i] === null || nv[i] === null ? null : t[i]! - a[i]! === nv[i]))) {
          push(`ADD_DAYS(${ref(A)}, ${ref(n)})`, `${label(A)} + ${label(n)} (days)`, [A, n], 2);
        }
      }
    }
  }

  // text: Full name = First name + " " + Last name
  for (const T of texts.filter((c) => c.type === "text")) {
    const t = S.get(T.name)!;
    const filled = t.filter((x) => x !== null).length;
    if (filled < MIN_ROWS) continue;
    for (const A of texts) {
      if (A === T) continue;
      const a = S.get(A.name)!;
      // quick test: the target starts with A on most rows
      if (!holds(t.length, filled, (i) => (t[i] === null || a[i] === null ? null : t[i]!.startsWith(a[i]!)))) continue;
      for (const B of texts) {
        if (B === T || B === A) continue;
        const b = S.get(B.name)!;
        for (const sep of [" ", ", ", " - ", "-", "/", ""]) {
          if (!holds(t.length, filled, (i) => (t[i] === null || a[i] === null || b[i] === null ? null : t[i] === a[i] + sep + b[i]))) continue;
          out.push({
            table: schema.tableName,
            target: T.name,
            position: position(T),
            kind: "formula",
            expression: sep ? `CONCAT(${ref(A)}, "${sep}", ${ref(B)})` : `CONCAT(${ref(A)}, ${ref(B)})`,
            inputs: dep(A, B),
            cost: 2,
            says: `${label(T)} = ${label(A)}${sep === " " ? " + a space + " : sep ? ` + "${sep}" + ` : " + "}${label(B)}`,
          });
          break;
        }
      }
    }
  }
  return out;
}

// Totals over linked records: Invoice total = the sum of its lines' Amount
async function totalCandidates(schemas: TableSchema[], samples: Map<string, Sample>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const P of schemas) {
    const rows = samples.get(P.tableName) ?? [];
    const targets = P.columns.filter((c) => c.type === "number" && distinct(rows.map((r) => num(r.data[c.name]))) >= 3);
    if (!targets.length || rows.length < MIN_ROWS) continue;
    for (const C of schemas) {
      if (C === P) continue;
      for (const via of C.columns.filter((c) => c.type === "relation" && c.ref === P.tableName)) {
        const fields = C.columns.filter((c) => valueType(c) === "number").slice(0, MAX_INPUTS);
        const probes: { fn: "count" | "sum"; field?: Column }[] = [{ fn: "count" }, ...fields.map((f) => ({ fn: "sum" as const, field: f }))];
        const sqls = probes.map((p, k) => {
          const rollup: RollupConfig = { from: C.tableName, via: via.name, fn: p.fn, type: "number", ...(p.field ? { field: p.field.name } : {}) };
          return `${computedSql({ name: "__probe__", type: "rollup", rollup } as Column, []).sql} AS r${k}`;
        });
        const { rows: got } = await query<Record<string, string | null>>(
          `SELECT t._id, ${sqls.join(", ")} FROM ${dataTable(P.tableName)} t WHERE t._id = ANY($1::text[])`,
          [rows.map((r) => r._id)]
        );
        const byId = new Map(got.map((g) => [g._id as string, g]));
        for (const T of targets) {
          const t = rows.map((r) => num(r.data[T.name]));
          const places = decimalsOf(t);
          probes.forEach((p, k) => {
            const values = rows.map((r) => num(byId.get(r._id)?.[`r${k}`]));
            // some records must have linked ones, or "0 = 0" proves nothing
            if (values.filter((x) => x).length < MIN_ROWS) return;
            if (numberFit(t, places, (i) => values[i]) !== "exact") return;
            out.push({
              table: P.tableName,
              target: T.name,
              position: P.columns.indexOf(T),
              kind: "total",
              rollup: { from: C.tableName, via: via.name, fn: p.fn, ...(p.field ? { field: p.field.name } : {}) },
              inputs: p.field ? [`${C.tableName}.${p.field.name}`] : [],
              cost: p.fn === "sum" ? 1 : 1.5,
              says: p.field
                ? `${label(T)} = the sum of ${label(p.field)} on its ${title(C.tableName)}`
                : `${label(T)} = how many ${title(C.tableName)} it has`,
            });
          });
        }
      }
    }
  }
  return out;
}

// The simplest rule for each field, never in a circle (Amount = Qty × Price
// rules out Price = Amount ÷ Qty)
function choose(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.cost - b.cost || b.position - a.position);
  const chosen = new Map<string, Candidate>();
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return Boolean(chosen.get(from)?.inputs.some((i) => reaches(i, to, seen)));
  };
  for (const c of sorted) {
    const node = `${c.table}.${c.target}`;
    if (chosen.has(node) || c.inputs.some((i) => reaches(i, node))) continue;
    chosen.set(node, c);
  }
  return [...chosen.values()];
}

// the rule as a conversion (schema/convert.ts)
const defOf = (r: Pick<Rule, "kind" | "expression" | "rollup">): Computed =>
  r.kind === "total" ? { kind: "total", rollup: r.rollup! } : { kind: "formula", expression: r.expression! };

/* ---------------- public ---------------- */

// Look through an import's tables. Never throws on odd data: a table that
// can't be read just gives no rules.
export async function findRules(tableNames: string[]): Promise<Rule[]> {
  const schemas = (await Promise.all(tableNames.map((n) => getSchema(n)))).filter((s): s is TableSchema => Boolean(s));
  const samples = new Map<string, Sample>();
  for (const s of schemas) {
    const { rows } = await query<{ _id: string; data: Record<string, unknown> }>(
      `SELECT _id, data FROM ${dataTable(s.tableName)} ORDER BY created_at, _id LIMIT ${SAMPLE}`
    );
    samples.set(s.tableName, rows);
  }
  const candidates = [...schemas.flatMap((s) => formulaCandidates(s, samples.get(s.tableName) ?? [])), ...(await totalCandidates(schemas, samples))];
  const chosen = choose(candidates).sort(
    (a, b) => tableNames.indexOf(a.table) - tableNames.indexOf(b.table) || a.position - b.position
  );
  const rules: Rule[] = [];
  for (const c of chosen) {
    if (rules.length >= MAX_RULES) break;
    const schema = schemas.find((s) => s.tableName === c.table)!;
    const target = schema.columns.find((col) => col.name === c.target)!;
    try {
      const proof = await prove(schema, target, asComputed(target, defOf(c)));
      if (proof.checked < MIN_ROWS || proof.fits < proof.checked * FIT) continue;
      rules.push({
        id: `${c.table}.${c.target}`,
        table: c.table,
        column: c.target,
        type: target.type,
        kind: c.kind,
        ...(c.expression ? { expression: c.expression } : {}),
        ...(c.rollup ? { rollup: c.rollup } : {}),
        says: c.says,
        ...(c.hint ? { hint: c.hint } : {}),
        ...proof,
        used: false,
      });
    } catch {
      // a guess the engine won't take: leave it out
    }
  }
  return rules;
}

// Check a rule again on today's records, with some records it would change
export const checkRule = (rule: Rule) => checkConversion(rule.table, rule.column, defOf(rule));

// Use a rule: the field becomes a formula (or total); Change back undoes it
export const useRule = (rule: Rule, userId: string | null) => convertColumn(rule.table, rule.column, defOf(rule), userId);
export const undoRule = (rule: Rule) => changeBack(rule.table, rule.column);

// what the page gets: whether each is in use now (made a formula, not changed back)
export async function shownRules(rules: Rule[]) {
  const now = await conversions([...new Set(rules.map((r) => r.table))]);
  return rules.map((r) => {
    const conv = now.find((c) => c.table_name === r.table && c.column_name === r.column);
    return { ...r, used: Boolean(conv), changed: conv?.changed ?? 0 };
  });
}
