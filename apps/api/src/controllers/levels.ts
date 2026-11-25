import type { Request, Response } from "express";
import { addLevel, deleteLevel, listLevels, moveOlderRoles, resetLevel, saveLevel } from "../auth/levels.js";
import { param } from "../lib/http.js";
import { audit } from "../repo/auditRepo.js";

// Administration → Access levels (admins): what each app's Staff, Manager
// and added levels may do, and moving older roles to levels.

export async function listLevelsHandler(_req: Request, res: Response) {
  res.json(await listLevels());
}

// PUT /access-levels/:app/:level { permissions }
export async function saveLevelHandler(req: Request, res: Response) {
  const app = param(req, "app");
  const level = param(req, "level");
  await saveLevel(app, level, req.body?.permissions);
  await audit(req, { action: "update", entity: "role", recordId: `${app}:${level}`, changes: { permissions: req.body?.permissions } });
  res.json({ message: "Saved" });
}

// POST /access-levels/:app { name }
export async function addLevelHandler(req: Request, res: Response) {
  const app = param(req, "app");
  const level = await addLevel(app, req.body ?? {});
  await audit(req, { action: "create", entity: "role", recordId: `${app}:${level.level}`, changes: { name: level.name } });
  res.status(201).json(level);
}

// DELETE /access-levels/:app/:level
export async function deleteLevelHandler(req: Request, res: Response) {
  const app = param(req, "app");
  const level = param(req, "level");
  await deleteLevel(app, level);
  await audit(req, { action: "delete", entity: "role", recordId: `${app}:${level}` });
  res.json({ message: "Level removed" });
}

// POST /access-levels/:app/:level/reset
export async function resetLevelHandler(req: Request, res: Response) {
  const app = param(req, "app");
  const level = param(req, "level");
  await resetLevel(app, level);
  await audit(req, { action: "update", entity: "role", recordId: `${app}:${level}`, changes: { reset: true } });
  res.json({ message: "Back to the app's defaults" });
}

// POST /access-levels/move { apply }: preview (apply false) or move older roles
export async function moveHandler(req: Request, res: Response) {
  const apply = req.body?.apply === true;
  const result = await moveOlderRoles(apply);
  if (apply && result.moved) await audit(req, { action: "update", entity: "role", recordId: "older-roles", changes: { moved: result.roles.map((r) => r.name) } });
  res.json(result);
}
