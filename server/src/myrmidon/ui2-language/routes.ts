// myrmidon(UI2-I18N): routes for the per-user UI language preference.
//
// GET/PUT /api/myrmidon/ui2/language/me — board users only (the language is a
// person's interface choice, agents never read or write it). The route carries
// no :companyId: the preference is instance-wide per user. PUT writes the row
// and one activity log entry per company membership, the same way the sidebar
// preferences route handles its project-order write.
//
// Responses:
//   200 { language: "en" | "ru", updatedAt: Date | null }
//   403 non-board actor, or board actor without a user id
//   400 body fails upsertUi2LanguageSchema (repo convention: Zod parse failures answer 400)

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { upsertUi2LanguageSchema, type Ui2Language } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { getActorInfo } from "../../routes/authz.js";
// myrmidon(1.7-TG-LOCALE): the Settings → Language screen shows the source of
// the effective value, including the instance-wide env force on the Telegram
// bridge's language (null when unset).
// myrmidon(1.6.5-TG-LOCALE-C): the same read now also reports the instance
// setting and resolves the full order env → user → instance → default.
import { resolveBridgeLocaleDecision } from "../agent-chat-bridge/locales/index.js";
import {
  createUi2LanguageService,
  ui2LanguageAuditEntries,
  type Ui2LanguageServiceDeps,
} from "./service.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board access required" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function ui2LanguageRoutes(db: Db, deps?: Ui2LanguageServiceDeps) {
  const router = Router();
  const service = deps ?? createUi2LanguageService(db);

  router.get("/myrmidon/ui2/language/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const language = await service.getLanguage(userId);
    // myrmidon(1.7-TG-LOCALE): the Settings → Language screen must show the
    // SOURCE of the effective value. `telegramBridge.source` is
    // "environment" while MYRMIDON_TELEGRAM_DM_LANGUAGE forces all bridged DM
    // texts instance-wide; "user" when the person's own preference decides.
    // myrmidon(1.6.5-TG-LOCALE-C): "instance" when the stored instance
    // language decides (a board user who never chose one), "default" when the
    // English fallback is all that is left. Recomputed per read: the env var
    // and the settings row are read on every request, so a screen refresh
    // shows the truth without a server restart.
    const bridge = await service.resolveBridgeLanguage(userId);
    res.json({
      language: language ?? "en",
      updatedAt: null,
      telegramBridge: {
        source: bridge.source,
        language: bridge.language,
        ...(bridge.forcedLanguage ? { forcedLanguage: bridge.forcedLanguage } : {}),
        ...(bridge.instanceLanguage ? { instanceLanguage: bridge.instanceLanguage } : {}),
      },
    });
  });

  router.put("/myrmidon/ui2/language/me", validate(upsertUi2LanguageSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const language = req.body.language as Ui2Language;
    const previous = await service.getLanguage(userId);
    const result = await service.upsertLanguage(userId, language);
    const companyIds = await service.listCompanyIdsForUser(userId);
    const actor = getActorInfo(req);
    for (const entry of ui2LanguageAuditEntries(userId, language, previous, companyIds, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    })) {
      await service.logActivity(entry);
    }
    res.json(result);
  });

  return router;
}
