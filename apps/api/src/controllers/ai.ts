import type { Request, Response } from "express";
import { ask, canAsk } from "../ai/assistant.js";
import { applyAccess, askAccess, canUseAccessAi } from "../ai/accessAssistant.js";
import { HttpError } from "../lib/http.js";
import { testAi } from "../ai/generate.js";
import { usageOverview } from "../ai/usage.js";
import { isAdmin } from "../auth/access.js";
import { currentUser } from "../middleware/auth.js";
import { getAiSettings, PROVIDER_NAMES, publicAiSettings, saveAiSettings } from "../ai/settings.js";
import { audit } from "../repo/auditRepo.js";

// Administration → AI (admins): which AI drafts apps, and its key.

// GET /ai
export async function getAiHandler(_req: Request, res: Response) {
  res.json(publicAiSettings(await getAiSettings()));
}

// PUT /ai { provider, key?, model?, removeKey? }
export async function saveAiHandler(req: Request, res: Response) {
  const before = await getAiSettings();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const saved = await saveAiSettings(body);
  // never the key itself in the audit log
  await audit(req, {
    action: "settings",
    entity: "ai",
    changes: {
      provider: saved.provider,
      model: saved.model || null,
      ...(body.features ? { features: saved.features } : {}),
      ...(body.limits ? { limits: saved.limits } : {}),
      key: body.removeKey === true ? "removed" : typeof body.key === "string" && body.key.trim() ? (before.keys[saved.provider] ? "replaced" : "added") : "unchanged",
    },
  });
  res.json({ message: "AI settings saved", settings: publicAiSettings(saved) });
}

// POST /ai/test: one tiny request with the saved key
export async function testAiHandler(req: Request, res: Response) {
  const me = currentUser(req);
  const { provider, model } = await testAi({ _id: me._id, isAdmin: isAdmin(me) });
  res.json({ message: `${PROVIDER_NAMES[provider]} is working (${model})` });
}

// GET /ai/usage: this month and last, by feature and by person (estimates)
export async function aiUsageHandler(_req: Request, res: Response) {
  res.json(await usageOverview());
}

// GET /ai/assistant: may this person use Ask Zenin? (shows the Ask button)
export async function assistantHandler(req: Request, res: Response) {
  res.json({ available: await canAsk(currentUser(req)) });
}

// POST /ai/ask { turns: [{ role, content }] }: the answer to the last question
export async function askHandler(req: Request, res: Response) {
  res.json(await ask(currentUser(req), (req.body ?? {}).turns));
}

/* ---------------- Change access with AI (admins) ---------------- */

// GET /ai/access: whether the Users page shows "Tell Zenin what to change"
export async function accessAvailableHandler(req: Request, res: Response) {
  res.json({ available: await canUseAccessAi(currentUser(req)) });
}

// POST /ai/access { turns }: an answer, and maybe a suggestion with its preview (nothing saved)
export async function accessAskHandler(req: Request, res: Response) {
  res.json(await askAccess(currentUser(req), req.body?.turns));
}

// POST /ai/access/apply { summary, changes }: the admin applies a suggestion
export async function accessApplyHandler(req: Request, res: Response) {
  if (!(await canUseAccessAi(currentUser(req)))) throw new HttpError(403, "Change access with AI isn't switched on.");
  const preview = await applyAccess(req.body ?? {}, async (change, text) => {
    await audit(req, {
      action: "update",
      entity: change.kind === "set_level_rights" || change.kind === "add_level" ? "role" : "user",
      recordId: "person_id" in change ? change.person_id : `${change.app}`,
      changes: { madeWithAi: true, change: text },
    });
  });
  res.json({ message: "Applied", preview });
}
