// Formulas without typing mistakes (docs/WORKFLOW.md "Formula columns"):
// the recipes behind the formula box's click-to-build choices, and
// tidyFormula(), which turns Excel-style typing into a real formula.

import { columnLabel, valueType, type RecordColumn } from "./schema";

/* ---------------- Excel-style typing ---------------- */

const WORD = /[A-Za-z0-9_]/;
// words that mean something in a formula, never a field
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

// "=Qty*Price", "qty × price", "Unit price * Qty" -> "{qty} * {price}" …:
// field names and labels without braces become {name} (longest first, not
// inside quotes or braces, not a function name); × ÷ − become * / -; a
// leading = goes. Anything else is left for the server to check.
export function tidyFormula(text: string, columns: RecordColumn[]): string {
  let src = text.trim().replace(/^=+\s*/, "");
  src = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const names = columns
    .flatMap((c) => [
      { word: columnLabel(c).toLowerCase(), name: c.name },
      { word: c.name.toLowerCase(), name: c.name },
    ])
    .filter((n) => n.word && !KEYWORDS.has(n.word))
    .sort((a, b) => b.word.length - a.word.length);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // quoted text and {fields} stay as they are
    if (ch === '"' || ch === "'" || ch === "{") {
      const close = ch === "{" ? "}" : ch;
      const end = src.indexOf(close, i + 1);
      const stop = end === -1 ? src.length : end + 1;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    const atWordStart = !WORD.test(src[i - 1] ?? "");
    const hit = atWordStart
      ? names.find((n) => {
          if (src.slice(i, i + n.word.length).toLowerCase() !== n.word) return false;
          if (WORD.test(src[i + n.word.length] ?? "")) return false;
          // a function, like ROUND( or IF(
          return !/^\s*\(/.test(src.slice(i + n.word.length));
        })
      : undefined;
    if (hit) {
      out += `{${hit.name}}`;
      i += hit.word.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/* ---------------- recipes ---------------- */

export type RecipeKind = "multiply" | "add" | "subtract" | "percent" | "days" | "dateplus" | "join";
export type ResultType = "number" | "date" | "text";

export const RECIPES: { kind: RecipeKind; label: string; result: ResultType }[] = [
  { kind: "multiply", label: "Multiply", result: "number" },
  { kind: "add", label: "Add up", result: "number" },
  { kind: "subtract", label: "Subtract", result: "number" },
  { kind: "percent", label: "Percentage of", result: "number" },
  { kind: "days", label: "Days between dates", result: "number" },
  { kind: "dateplus", label: "Date + days", result: "date" },
  { kind: "join", label: "Join text", result: "text" },
];

export const SEPARATORS = [
  { value: " ", label: "a space", says: " + a space + " },
  { value: ", ", label: "a comma", says: ' + ", " + ' },
  { value: " - ", label: "a dash", says: ' + " - " + ' },
  { value: "", label: "nothing", says: " + " },
];

// the fields a recipe can use (never the field being worked out)
export function fieldsFor(kind: RecipeKind, columns: RecordColumn[], target?: string) {
  const usable = columns.filter((c) => c.name !== target);
  if (kind === "days" || kind === "dateplus") return usable.filter((c) => valueType(c) === "date");
  if (kind === "join") return usable.filter((c) => ["text", "autonumber", "number"].includes(valueType(c)) || (c.type === "choice" && !c.multiple));
  return usable.filter((c) => valueType(c) === "number");
}
// fields a recipe needs before it makes sense
export const NEEDS: Record<RecipeKind, number> = { multiply: 2, add: 2, subtract: 2, percent: 1, days: 2, dateplus: 1, join: 2 };

// the recipes that fit: they give the field's kind of value, and there are
// enough fields for them
export const recipesFor = (columns: RecordColumn[], target?: string, resultType?: ResultType) =>
  RECIPES.filter((r) => (!resultType || r.result === resultType) && fieldsFor(r.kind, columns, target).length >= NEEDS[r.kind]);

export type Recipe = {
  kind: RecipeKind;
  fields: (string | null)[]; // picked fields, in order
  percent: number | "";
  days: number | ""; // Date + days: a fixed number…
  daysField: string | null; // …or a field
  daysFrom: "number" | "field";
  separator: string;
  countBoth: boolean;
  round: boolean;
  decimals: number;
};

export const newRecipe = (kind: RecipeKind): Recipe => ({
  kind,
  fields: [null, null],
  percent: "",
  days: 30,
  daysField: null,
  daysFrom: "number",
  separator: " ",
  countBoth: false,
  round: kind === "percent",
  decimals: 2,
});

// 18 -> "0.18", without floating-point tails
const fixed = (n: number) => String(Number(n.toPrecision(12)));

// The formula a recipe writes, and what it says in words ("" and null while
// a blank is still empty)
export function buildRecipe(r: Recipe, columns: RecordColumn[], targetLabel: string): { expression: string; says: string } | null {
  const col = (name: string | null) => columns.find((c) => c.name === name);
  const picked = r.fields.map(col).filter((c): c is RecordColumn => Boolean(c));
  const ref = (c: RecordColumn) => `{${c.name}}`;
  const lbl = (c: RecordColumn) => columnLabel(c);
  const rounded = (expr: string, says: string) =>
    r.round && r.kind !== "days"
      ? { expression: `ROUND(${expr}, ${r.decimals})`, says: `${says}, rounded to ${r.decimals ? `${r.decimals} decimal${r.decimals === 1 ? "" : "s"}` : "whole numbers"}` }
      : { expression: expr, says };
  const done = (x: { expression: string; says: string }) => ({ expression: x.expression, says: `${targetLabel} = ${x.says}` });

  switch (r.kind) {
    case "multiply":
    case "add":
    case "subtract": {
      if (picked.length < 2 || picked.length !== r.fields.filter(Boolean).length) return null;
      const [op, sign] = r.kind === "multiply" ? [" * ", " × "] : r.kind === "add" ? [" + ", " + "] : [" - ", " − "];
      return done(rounded(picked.map(ref).join(op), picked.map(lbl).join(sign)));
    }
    case "percent": {
      const of = picked[0];
      if (!of || r.percent === "" || !Number.isFinite(r.percent)) return null;
      return done(rounded(`${ref(of)} * ${fixed(r.percent / 100)}`, `${fixed(r.percent)}% of ${lbl(of)}`));
    }
    case "days": {
      const [from, to] = r.fields.map(col);
      if (!from || !to) return null;
      return done({
        expression: `DAYS(${ref(to)}, ${ref(from)})${r.countBoth ? " + 1" : ""}`,
        says: `days from ${lbl(from)} to ${lbl(to)}${r.countBoth ? ", counting both" : ""}`,
      });
    }
    case "dateplus": {
      const date = picked[0];
      if (!date) return null;
      if (r.daysFrom === "field") {
        const n = col(r.daysField);
        return n ? done({ expression: `ADD_DAYS(${ref(date)}, ${ref(n)})`, says: `${lbl(date)} + ${lbl(n)} (days)` }) : null;
      }
      if (r.days === "" || !Number.isFinite(r.days)) return null;
      const d = Math.round(r.days);
      return done({ expression: `ADD_DAYS(${ref(date)}, ${d})`, says: `${lbl(date)} ${d < 0 ? "−" : "+"} ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"}` });
    }
    case "join": {
      if (picked.length < 2 || picked.length !== r.fields.filter(Boolean).length) return null;
      const sep = SEPARATORS.find((s) => s.value === r.separator) ?? SEPARATORS[0];
      const parts = picked.flatMap((c, i) => (i && sep.value ? [`"${sep.value}"`, ref(c)] : [ref(c)]));
      return done({ expression: `CONCAT(${parts.join(", ")})`, says: picked.map(lbl).join(sep.says) });
    }
  }
}
