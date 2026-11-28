import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Column, RollupConfig, TableSchema } from "../types.js";
import { pickDisplayField } from "./columns.js";
import { computedSql } from "./formula.js";
import { getSchema, replaceColumn } from "./schemaRepo.js";

// Make a typed field (Number, Date, Text) a formula or a total, in place:
// "Make it a formula" (column settings, = in the spreadsheet) and "Use it" on
// a rule found in imported data (migration/rules.ts). One formula for the
// whole column, never per cell. Checked first on every record; the values it
// replaces are kept (column_conversions) so Change back can put them back.

export type Computed = { kind: "formula"; expression: string } | { kind: "total"; rollup: RollupConfig };
export type Proof = { checked: number; fits: number; differ: number; fills: number };

// types a field can be made a formula from
export const CONVERTIBLE = ["number", "date", "text"];
// values a conversion may replace and still be undone
export const MAX_RESTORE = 5_000;

const label = (c: Column) => c.label || c.name;

// the field as a formula or total (not saved)
export function asComputed(column: Column, def: Computed): Column {
  const made: Column = { ...column, required: false };
  delete made.default;
  delete made.options;
  if (def.kind === "total") return { ...made, type: "rollup", rollup: { ...def.rollup, type: "number" } };
  return { ...made, type: "formula", formula: { expression: def.expression } };
}

// SQL for the stored value (s) and the computed one (c) of a record t
export function sides(target: Column, computed: Column, columns: Column[]) {
  const { sql, type } = computedSql(computed, columns);
  const key = quoteLiteral(target.name);
  if (type === "number") return { s: `round(erp_try_numeric(t.data ->> ${key}), 6)`, c: `round((${sql})::numeric, 6)`, shown: (x: string) => `trim_scale(${x})::text` };
  if (type === "date") return { s: `erp_try_date(t.data ->> ${key})`, c: `(${sql})`, shown: (x: string) => `to_char(${x}, 'YYYY-MM-DD')` };
  return { s: `NULLIF(t.data ->> ${key}, '')`, c: `NULLIF(${sql}::text, '')`, shown: (x: string) => x };
}

// How the computed values compare with the stored ones, on every record
export async function prove(schema: TableSchema, target: Column, computed: Column, client?: pg.PoolClient): Promise<Proof> {
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

async function fieldNow(tableName: string, columnName: string) {
  const schema = await getSchema(tableName);
  const column = schema?.columns.find((c) => c.name === columnName);
  if (!schema || !column) throw new HttpError(404, "That field isn't in the table any more");
  return { schema, column };
}

const assertConvertible = (column: Column) => {
  if (!CONVERTIBLE.includes(column.type)) {
    throw new HttpError(400, `"${label(column)}" can't be made a formula: only Number, Date and Text fields can`);
  }
};

// The formula on today's records: how well it fits, and up to 10 records it
// would change (now → becomes). Formula problems come back as a 400.
export async function checkConversion(tableName: string, columnName: string, def: Computed) {
  const { schema, column } = await fieldNow(tableName, columnName);
  assertConvertible(column);
  const computed = asComputed(column, def);
  const columns = schema.columns.map((c) => (c.name === column.name ? computed : c));
  const { type } = computedSql(computed, columns);
  if (type !== column.type && !(column.type === "text")) {
    const kinds: Record<string, string> = { number: "a number", date: "a date", text: "text", boolean: "Yes / No" };
    throw new HttpError(400, `This formula gives ${kinds[type] ?? type}, but "${label(column)}" holds ${kinds[column.type] ?? column.type}`);
  }
  const proof = await prove({ ...schema, columns }, column, computed);
  const { s, c, shown } = sides(column, computed, columns);
  const name = pickDisplayField(schema);
  const { rows } = await query<{ id: string; title: string | null; now: string | null; becomes: string | null }>(
    `SELECT t._id AS id, ${name === "_id" || name === column.name ? "t._id" : `t.data ->> ${quoteLiteral(name)}`} AS title,
            t.data ->> ${quoteLiteral(column.name)} AS now, ${shown(c)} AS becomes
       FROM ${dataTable(tableName)} t
      WHERE ${s} IS NOT NULL AND ${c} IS DISTINCT FROM ${s}
      ORDER BY t.created_at LIMIT 10`
  );
  return { proof, examples: rows };
}

// Make the field a formula (or total). Returns how many records changed.
export async function convertColumn(tableName: string, columnName: string, def: Computed, userId: string | null) {
  const { column } = await fieldNow(tableName, columnName);
  assertConvertible(column);
  let changed = 0;
  const { before, after } = await replaceColumn(
    tableName,
    columnName,
    (current) => asComputed(current, def),
    async (client, columns) => {
      const made = columns.find((c) => c.name === columnName)!;
      const { s, c } = sides(column, made, columns);
      // the values it replaces (and the empty ones it fills), for Change back
      const { rows } = await query<{ id: string; v: unknown }>(
        `SELECT t._id AS id, t.data -> ${quoteLiteral(columnName)} AS v FROM ${dataTable(tableName)} t
          WHERE (${s} IS NOT NULL AND ${c} IS DISTINCT FROM ${s}) OR (${s} IS NULL AND ${c} IS NOT NULL)
          LIMIT ${MAX_RESTORE + 1}`,
        [],
        client
      );
      if (rows.length > MAX_RESTORE) {
        throw new HttpError(409, `More than ${MAX_RESTORE.toLocaleString("en-IN")} records would change: too many to undo. Check the formula, or fix the old values first.`);
      }
      changed = rows.length;
      await query(
        `INSERT INTO column_conversions (table_name, column_name, original, restore, changed, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         ON CONFLICT (table_name, column_name) DO UPDATE SET original = EXCLUDED.original, restore = EXCLUDED.restore,
           changed = EXCLUDED.changed, created_by = EXCLUDED.created_by, created_at = now()`,
        [tableName, columnName, JSON.stringify(column), JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.v ?? null]))), changed, userId],
        client
      );
    }
  );
  return { before, after, changed };
}

// Fields made into formulas that can be changed back, by table
export async function conversions(tableNames: string[]) {
  const { rows } = await query<{ table_name: string; column_name: string; from: string; changed: number }>(
    `SELECT table_name, column_name, original ->> 'type' AS from, changed FROM column_conversions WHERE table_name = ANY($1::text[])`,
    [tableNames]
  );
  return rows;
}

export async function conversionOf(tableName: string, columnName: string) {
  const { column } = await fieldNow(tableName, columnName);
  if (column.type !== "formula" && column.type !== "rollup") return null;
  const row = (await conversions([tableName])).find((r) => r.column_name === columnName);
  return row ? { from: row.from, changed: row.changed } : null;
}

// Change back: the field as it was (keeping today's label and who sees it),
// and the values the formula replaced. Records changed since keep today's.
export async function changeBack(tableName: string, columnName: string) {
  const { column } = await fieldNow(tableName, columnName);
  const { rows } = await query<{ original: Column; restore: Record<string, unknown>; changed: number }>(
    `SELECT original, restore, changed FROM column_conversions WHERE table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  if (!rows[0] || (column.type !== "formula" && column.type !== "rollup")) throw new HttpError(409, `"${label(column)}" wasn't made a formula here, so there's nothing to change back`);
  const { original, restore, changed } = rows[0];
  const key = quoteLiteral(columnName);
  const { before, after } = await replaceColumn(
    tableName,
    columnName,
    (current) => ({ ...original, label: current.label, showInTable: current.showInTable, onlyLevels: current.onlyLevels }),
    async (client) => {
      await query(
        `UPDATE ${dataTable(tableName)} t
            SET data = CASE WHEN jsonb_typeof(s.value) = 'null' THEN t.data - ${key} ELSE t.data || jsonb_build_object(${key}, s.value) END
           FROM jsonb_each($1::jsonb) s WHERE t._id = s.key`,
        [JSON.stringify(restore)],
        client
      );
      await query(`DELETE FROM column_conversions WHERE table_name = $1 AND column_name = $2`, [tableName, columnName], client);
    }
  );
  return { before, after, changed };
}
