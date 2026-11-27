import { query } from "../db/pool.js";
import type { Plan } from "./analyze.js";

// Bring your data: the on/off switch (app_state "migration") and the imports
// (the `migrations` table, migration 021).

/* ---------------- the switch ---------------- */

let cache: { at: number; enabled: boolean } | null = null;

export async function migrationEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 15_000) return cache.enabled;
  const { rows } = await query<{ value: { enabled?: boolean } }>(`SELECT value FROM app_state WHERE key = 'migration'`);
  cache = { at: Date.now(), enabled: rows[0]?.value?.enabled === true }; // off by default
  return cache.enabled;
}

export async function setMigrationEnabled(enabled: boolean) {
  await query(
    `INSERT INTO app_state (key, value) VALUES ('migration', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ enabled })]
  );
  cache = null;
}

/* ---------------- imports ---------------- */

export type MigrationStatus = "review" | "importing" | "done" | "failed";

export type TableProof = {
  table: string; // Zenin table name
  source: string;
  rowsInFile: number;
  imported: number;
  // number columns: the total in the file and in Zenin
  totals: { column: string; label: string; file: number; zenin: number; match: boolean }[];
  problems: number;
};
export type MigrationResult = { tables: TableProof[]; problems: number; allMatch: boolean };

export type Migration = {
  _id: string;
  name: string;
  status: MigrationStatus;
  plan: Plan;
  fileKeys: string[];
  fileNames: string[];
  appKey: string | null;
  createdTables: string[];
  result: MigrationResult | null;
  error: string | null;
  problemsKey: string | null;
  jobId: string | null;
  createdAt: Date;
};

type Row = {
  _id: string;
  name: string;
  status: MigrationStatus;
  plan: Plan;
  file_keys: string[];
  file_names: string[];
  app_key: string | null;
  created_tables: string[];
  result: MigrationResult | null;
  error: string | null;
  problems_key: string | null;
  job_id: string | null;
  created_at: Date;
};

const toMigration = (r: Row): Migration => ({
  _id: r._id,
  name: r.name,
  status: r.status,
  plan: r.plan,
  fileKeys: r.file_keys,
  fileNames: r.file_names,
  appKey: r.app_key,
  createdTables: r.created_tables,
  result: r.result,
  error: r.error,
  problemsKey: r.problems_key,
  jobId: r.job_id,
  createdAt: r.created_at,
});

export async function createMigration(input: { id: string; name: string; plan: Plan; fileKeys: string[]; fileNames: string[]; userId: string }) {
  const { rows } = await query<Row>(
    `INSERT INTO migrations (_id, name, plan, file_keys, file_names, created_by) VALUES ($1, $2, $3::jsonb, $4::text[], $5::text[], $6) RETURNING *`,
    [input.id, input.name, JSON.stringify(input.plan), input.fileKeys, input.fileNames, input.userId]
  );
  return toMigration(rows[0]);
}

export async function getMigration(id: string) {
  const { rows } = await query<Row>(`SELECT * FROM migrations WHERE _id = $1`, [id]);
  return rows[0] ? toMigration(rows[0]) : null;
}

export async function listMigrations() {
  const { rows } = await query<Row>(`SELECT * FROM migrations ORDER BY created_at DESC LIMIT 50`);
  return rows.map(toMigration);
}

export async function updateMigration(
  id: string,
  patch: Partial<{ plan: Plan; status: MigrationStatus; appKey: string | null; createdTables: string[]; result: MigrationResult | null; error: string | null; problemsKey: string | null; jobId: string | null }>
) {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const put = (col: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.plan !== undefined) put("plan", JSON.stringify(patch.plan), "::jsonb");
  if (patch.status !== undefined) put("status", patch.status);
  if (patch.appKey !== undefined) put("app_key", patch.appKey);
  if (patch.createdTables !== undefined) put("created_tables", patch.createdTables, "::text[]");
  if (patch.result !== undefined) put("result", patch.result === null ? null : JSON.stringify(patch.result), "::jsonb");
  if (patch.error !== undefined) put("error", patch.error);
  if (patch.problemsKey !== undefined) put("problems_key", patch.problemsKey);
  if (patch.jobId !== undefined) put("job_id", patch.jobId);
  if (!sets.length) return;
  await query(`UPDATE migrations SET ${sets.join(", ")}, updated_at = now() WHERE _id = $1`, params);
}

export const deleteMigrationRow = (id: string) => query(`DELETE FROM migrations WHERE _id = $1`, [id]);
