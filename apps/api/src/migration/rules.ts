import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { pickDisplayField, valueType } from "../schema/columns.js";
import { computedSql } from "../schema/formula.js";
import { getSchema, replaceColumn } from "../schema/schemaRepo.js";
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
  used: boolean;
  // while in use, for Change back (never sent to the browser)
  original?: Column;
  restore?: Record<string, unknown>; // record id -> the value the rule replaced (null: was empty)
};

const FIT = 0.98;
const MIN_ROWS = 10;
const SAMPLE = 2_000;
const MAX_INPUTS = 25;
const MAX_RULES = 40;
// records a rule may change and still be undone
export const MAX_RESTORE = 5_000;
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

/* ---------------- proof, on every record ---------------- */

// the field as a formula or total (not saved)
function asComputed(column: Column, rule: Pick<Rule, "kind" | "expression" | "rollup">): Column {
  const made: Column = { ...column, required: false };
  delete made.default;
  if (rule.kind === "total") return { ...made, type: "rollup", rollup: { ...rule.rollup!, type: "number" } };
  return { ...made, type: "formula", formula: { expression: rule.expression! } };
}

// SQL for the stored value (s) and the rule's value (c) of a record t
function sides(target: Column, computed: Column, columns: Column[]) {
  const { sql, type } = computedSql(computed, columns);
  const key = quoteLiteral(target.name);
  if (type === "number") return { s: `round(erp_try_numeric(t.data ->> ${key}), 6)`, c: `round((${sql})::numeric, 6)`, shown: (x: string) => `trim_scale(${x})::text` };
  if (type === "date") return { s: `erp_try_date(t.data ->> ${key})`, c: `(${sql})`, shown: (x: string) => `to_char(${x}, 'YYYY-MM-DD')` };
  return { s: `NULLIF(t.data ->> ${key}, '')`, c: `NULLIF(${sql}, '')`, shown: (x: string) => x };
}

type Proof = { checked: number; fits: number; differ: number; fills: number };

async function prove(schema: TableSchema, target: Column, computed: Column, client?: pg.PoolClient): Promise<Proof> {
  const { s, c } = sides(target, computed, schema.columns);
  const { rows } = await query<Proof>(
    `SELECT count(*) FILTER (WHERE s IS NOT NULL)::int AS checked,
            count(*) FILTER (WHERE s IS NOT NULL AND s = c)::int AS fits,
            count(*) FILTER (WHERE s IS NOT NULL AND c IS DISTINCT FROM s)::int AS differ,
            count(*) FILTER (WHERE s IS NULL AND c IS NOT NULL)::int AS fills
       FROM (SELECT ${s} AS s, ${c} AS c FROM ${dataTable(schema.tableName)} t) x`,
    [],
    client
  );
  return rows[0];
}

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
      const proof = await prove(schema, target, asComputed(target, c));
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

const fieldNow = async (rule: Rule) => {
  const schema = await getSchema(rule.table);
  const column = schema?.columns.find((c) => c.name === rule.column);
  if (!schema || !column) throw new HttpError(404, "That field isn't in the table any more");
  return { schema, column };
};

// Check a rule again on today's records, with some records it would change
export async function checkRule(rule: Rule) {
  const { schema, column } = await fieldNow(rule);
  if (rule.used) return { proof: null, examples: [] };
  if (column.type !== rule.type) throw new HttpError(409, `"${label(column)}" has changed since: it isn't a ${rule.type} field any more`);
  const computed = asComputed(column, rule);
  const proof = await prove(schema, column, computed);
  const { s, c, shown } = sides(column, computed, schema.columns);
  const name = pickDisplayField(schema);
  const { rows } = await query<{ id: string; title: string | null; now: string | null; becomes: string | null }>(
    `SELECT t._id AS id, ${name === "_id" ? "t._id" : `t.data ->> ${quoteLiteral(name)}`} AS title,
            t.data ->> ${quoteLiteral(column.name)} AS now, ${shown(c)} AS becomes
       FROM ${dataTable(schema.tableName)} t
      WHERE ${s} IS NOT NULL AND ${c} IS DISTINCT FROM ${s}
      ORDER BY t.created_at LIMIT 10`
  );
  return { proof, examples: rows };
}

// Use a rule: the field becomes a formula (or total). The values it changes
// are kept on the rule, so Change back can put them back.
export async function useRule(rule: Rule): Promise<{ rule: Rule; changed: number }> {
  const { column } = await fieldNow(rule);
  if (rule.used) throw new HttpError(409, "This rule is already in use");
  if (column.type !== rule.type) throw new HttpError(409, `"${label(column)}" has changed since: it isn't a ${rule.type} field any more`);
  let restore: Record<string, unknown> = {};
  const { before } = await replaceColumn(
    rule.table,
    rule.column,
    (current) => asComputed(current, rule),
    async (client, columns) => {
      const made = columns.find((c) => c.name === rule.column)!;
      const { s, c } = sides(column, made, columns);
      const { rows } = await query<{ id: string; v: unknown }>(
        `SELECT t._id AS id, t.data -> ${quoteLiteral(rule.column)} AS v FROM ${dataTable(rule.table)} t
          WHERE (${s} IS NOT NULL AND ${c} IS DISTINCT FROM ${s}) OR (${s} IS NULL AND ${c} IS NOT NULL)
          LIMIT ${MAX_RESTORE + 1}`,
        [],
        client
      );
      if (rows.length > MAX_RESTORE) {
        throw new HttpError(409, `More than ${MAX_RESTORE.toLocaleString("en-IN")} records would change: too many to undo. Fix the old values first.`);
      }
      restore = Object.fromEntries(rows.map((r) => [r.id, r.v ?? null]));
    }
  );
  return { rule: { ...rule, used: true, original: before, restore }, changed: Object.keys(restore).length };
}

// Change back: a normal field again; the values the rule changed come back
export async function undoRule(rule: Rule): Promise<Rule> {
  const { column } = await fieldNow(rule);
  if (!rule.used || !rule.original) throw new HttpError(409, "This rule isn't in use");
  if (column.type !== "formula" && column.type !== "rollup") throw new HttpError(409, `"${label(column)}" isn't worked out by a rule any more`);
  const key = quoteLiteral(rule.column);
  await replaceColumn(
    rule.table,
    rule.column,
    (current) => ({ ...rule.original!, label: current.label, showInTable: current.showInTable, onlyLevels: current.onlyLevels }),
    async (client) => {
      if (!Object.keys(rule.restore ?? {}).length) return;
      await query(
        `UPDATE ${dataTable(rule.table)} t
            SET data = CASE WHEN jsonb_typeof(s.value) = 'null' THEN t.data - ${key} ELSE t.data || jsonb_build_object(${key}, s.value) END
           FROM jsonb_each($1::jsonb) s WHERE t._id = s.key`,
        [JSON.stringify(rule.restore)],
        client
      );
    }
  );
  const back: Rule = { ...rule, used: false };
  delete back.original;
  delete back.restore;
  return back;
}

// what the page gets: no undo data
export const shownRule = (r: Rule) => {
  const { original: _o, restore, ...rest } = r;
  return { ...rest, changed: restore ? Object.keys(restore).length : 0 };
};
