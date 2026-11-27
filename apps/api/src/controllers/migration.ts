import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import busboy from "busboy";
import { env } from "../config/env.js";
import { HttpError, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { createJob, getJob } from "../repo/jobRepo.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import { storage } from "../storage.js";
import { makePlan, readFiles, restatColumn, slug, type Plan, type PlanType, type SourceFile } from "../migration/analyze.js";
import { readStoredFiles, removeImported } from "../migration/run.js";
import {
  createMigration,
  deleteMigrationRow,
  getMigration,
  listMigrations,
  migrationEnabled,
  setMigrationEnabled,
  updateMigration,
  type Migration,
} from "../migration/store.js";

// Administration → Bring your data (docs/WORKFLOW.md). Admins only (routes).
// Off by default; while off, everything but the switch is refused.

const MAX_FILES = 20;
const TYPES: PlanType[] = ["text", "textarea", "number", "date", "boolean", "choice", "relation"];

async function requireOn() {
  if (!(await migrationEnabled())) throw new HttpError(403, "Bring your data is switched off. Turn it on in Administration → Bring your data.");
}

// what the page gets: the plan, the proof, and the progress while importing
async function shown(m: Migration) {
  const job = m.jobId && m.status === "importing" ? await getJob(m.jobId) : null;
  return {
    _id: m._id,
    name: m.name,
    status: m.status,
    fileNames: m.fileNames,
    plan: m.plan,
    createdTables: m.createdTables,
    appKey: m.appKey,
    result: m.result,
    error: m.error,
    hasProblems: Boolean(m.problemsKey),
    progress: job?.progress ?? (m.status === "done" ? 100 : 0),
    createdAt: m.createdAt,
  };
}

// GET /migration: the switch and the imports
export async function listHandler(_req: Request, res: Response) {
  const enabled = await migrationEnabled();
  res.json({ enabled, imports: enabled ? await Promise.all((await listMigrations()).map(shown)) : [] });
}

// PUT /migration/settings { enabled }
export async function settingsHandler(req: Request, res: Response) {
  if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  await setMigrationEnabled(req.body.enabled);
  await audit(req, { action: "settings", entity: "app", recordId: "migration", changes: { enabled: { to: req.body.enabled } } });
  res.json({ enabled: req.body.enabled });
}

// POST /migration/upload (multipart: files): read, work out the plan, keep the files
export async function uploadHandler(req: Request, res: Response) {
  await requireOn();
  if (!req.is("multipart/form-data")) throw new HttpError(400, "Expected multipart/form-data");
  const files: SourceFile[] = [];
  let total = 0;
  let tooLarge = false;
  const bb = busboy({ headers: req.headers, defParamCharset: "utf8", limits: { fileSize: env.importMaxBytes, files: MAX_FILES } });
  bb.on("file", (_name, stream, info) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => {
      total += c.length;
      if (total > env.importMaxBytes) tooLarge = true;
      else chunks.push(c);
    });
    stream.on("limit", () => (tooLarge = true));
    stream.on("end", () => files.push({ name: (info.filename || "file").slice(0, 120), buffer: Buffer.concat(chunks) }));
  });
  await new Promise<void>((resolve, reject) => {
    bb.on("close", resolve);
    bb.on("error", (err) => reject(new HttpError(400, `Upload failed: ${(err as Error).message}`)));
    req.pipe(bb);
  });
  const mb = Math.round(env.importMaxBytes / 1024 / 1024);
  if (tooLarge) throw new HttpError(413, `The files are larger than ${mb} MB together. Split them, or ask for help with a bigger move.`);
  if (!files.length) throw new HttpError(400, "Choose an Excel (.xlsx) or CSV file");

  let sheets;
  try {
    sheets = await readFiles(files);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!sheets.length) throw new HttpError(400, "The files have no rows in them");
  const plan = makePlan(sheets, new Set((await getAllSchemas()).map((s) => s.tableName)));

  const id = randomUUID();
  const keys: string[] = [];
  for (const [i, f] of files.entries()) {
    const key = `migrations/${id}/${i}-${slug(f.name, "file")}`;
    await storage.put(key, f.buffer, "application/octet-stream");
    keys.push(key);
  }
  const name = files.length === 1 ? files[0].name : `${files.length} files`;
  const migration = await createMigration({ id, name, plan, fileKeys: keys, fileNames: files.map((f) => f.name), userId: currentUser(req)._id });
  await audit(req, { action: "create", entity: "app", recordId: `migration:${id}`, changes: { files: { to: files.map((f) => f.name) } } });
  res.status(201).json(await shown(migration));
}

async function loadOne(req: Request) {
  await requireOn();
  const m = await getMigration(param(req, "id"));
  if (!m) throw new HttpError(404, "Import not found");
  return m;
}

// GET /migration/:id
export async function getHandler(req: Request, res: Response) {
  res.json(await shown(await loadOne(req)));
}

// PUT /migration/:id/plan { plan }: what the admin changed in the review (which
// tables and columns, names, labels, types). Counts are worked out again.
export async function planHandler(req: Request, res: Response) {
  const m = await loadOne(req);
  if (m.status !== "review") throw new HttpError(409, "This import has already run");
  const edited = req.body?.plan as Plan | undefined;
  if (!edited || !Array.isArray(edited.tables)) throw new HttpError(400, "plan is required");

  const sheets = await readFiles(await readStoredFiles(m.fileKeys, m.fileNames));
  const taken = new Set((await getAllSchemas()).map((s) => s.tableName.toLowerCase()));
  const names = new Set<string>();
  const next: Plan = { tables: [] };
  for (const original of m.plan.tables) {
    const e = edited.tables.find((t) => t.key === original.key) ?? original;
    const tableName = slug(String(e.tableName ?? original.tableName), "table");
    if (e.include !== false) {
      if (taken.has(tableName)) throw new HttpError(400, `There's already a table called "${tableName}"`, { [original.key]: "Name taken" });
      if (names.has(tableName)) throw new HttpError(400, `Two tables would be called "${tableName}"`);
      names.add(tableName);
    }
    const sheet = sheets.find((s) => s.file === original.file && s.sheet === original.sheet && s.source === original.source);
    const columns = original.columns.map((oc) => {
      const ec = e.columns?.find((c) => c.index === oc.index) ?? oc;
      const type = TYPES.includes(ec.type) ? ec.type : oc.type;
      // a link can only stay as found (or become something else)
      if (type === "relation" && oc.type !== "relation") throw new HttpError(400, `"${oc.source}": links are found automatically; it can't be made one by hand`);
      const col = { ...oc, include: ec.include !== false, label: String(ec.label ?? oc.label).trim().slice(0, 100) || oc.source, type };
      if (type === oc.type && type !== "choice") return col;
      try {
        return restatColumn(col, sheet ? sheet.rows.map((r) => r[oc.index] ?? "") : []);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    });
    next.tables.push({ ...original, include: e.include !== false, tableName, columns });
  }
  if (!next.tables.some((t) => t.include)) throw new HttpError(400, "Choose at least one table to import");
  await updateMigration(m._id, { plan: next });
  res.json(await shown((await getMigration(m._id))!));
}

// POST /migration/:id/import: run it in the background
export async function importHandler(req: Request, res: Response) {
  const m = await loadOne(req);
  if (m.status !== "review") throw new HttpError(409, "This import has already run");
  const taken = new Set((await getAllSchemas()).map((s) => s.tableName.toLowerCase()));
  const clash = m.plan.tables.find((t) => t.include && taken.has(t.tableName.toLowerCase()));
  if (clash) throw new HttpError(409, `There's already a table called "${clash.tableName}": rename it in the review`);
  const user = currentUser(req);
  const job = await createJob({ type: "migration", tableName: "", userId: user._id, username: user.username, params: { migrationId: m._id } });
  await updateMigration(m._id, { status: "importing", jobId: job._id, error: null });
  res.status(202).json(await shown((await getMigration(m._id))!));
}

// GET /migration/:id/problems: the values that didn't fit, as CSV
export async function problemsHandler(req: Request, res: Response) {
  const m = await loadOne(req);
  if (!m.problemsKey) throw new HttpError(404, "No problems were found in this import");
  const file = await storage.get(m.problemsKey);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="import-problems.csv"`);
  file.body.pipe(res);
}

// DELETE /migration/:id: forget a review, or remove an import's tables and app
export async function deleteHandler(req: Request, res: Response) {
  const m = await loadOne(req);
  if (m.status === "importing") throw new HttpError(409, "It's still importing: wait until it's done");
  if (m.status === "done") await removeImported(m.createdTables, m.appKey);
  for (const key of [...m.fileKeys, ...(m.problemsKey ? [m.problemsKey] : [])]) await storage.delete(key).catch(() => {});
  await deleteMigrationRow(m._id);
  await audit(req, { action: "delete", entity: "app", recordId: `migration:${m._id}`, changes: { tables: { from: m.createdTables } } });
  res.json({ message: m.status === "done" ? "Removed: its tables and records are deleted" : "Removed" });
}
