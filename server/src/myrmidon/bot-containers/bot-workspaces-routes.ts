// GET /api/myrmidon/bots/me/workspaces (myrmidon 1.6.5 BOT-DISK-H4a, contract C3).
//
// The desired state of the calling bot's task copies. Only an agent actor (the
// bot's own PAPERCLIP_API_KEY) may call it, and the answer is always about the
// caller: there is no way to ask for another bot. A board actor, an
// unauthenticated caller or any other actor gets 403 (401 when anonymous), and
// botd reads either as "keep all local state".

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { wsDesiredStateSchema } from "@paperclipai/shared";
import { HttpError, forbidden, unauthorized } from "../../errors.js";
import {
  botWorkspacesService,
  botWorkspacesStore,
  type BotWorkspacePressure,
  type BotWorkspacesService,
} from "./bot-workspaces-service.js";

export function botWorkspacesRoutes(service: BotWorkspacesService) {
  const router = Router();

  router.get("/myrmidon/bots/me/workspaces", async (req, res) => {
    if (req.actor.type === "none") throw unauthorized();
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Only a bot's own agent key can read its workspaces");
    }
    // The switch of the whole mechanism: botd reads a 503 as "no desired state" and deletes nothing.
    if (!(await service.isEnabled())) throw new HttpError(503, "bot disk lifecycle disabled");
    const state = await service.desiredState({ companyId: req.actor.companyId, agentId: req.actor.agentId });
    // Serialize exactly the contract: an off-contract answer is a server bug, not a client one.
    res.json(wsDesiredStateSchema.parse(state));
  });

  return router;
}

/** Router for app.ts, mounted under /api. */
export function myrmidonBotWorkspacesRoutes(
  db: Db,
  options: { readPressure?: (input: { agentId: string }) => Promise<BotWorkspacePressure | null> } = {},
) {
  return botWorkspacesRoutes(botWorkspacesService({ store: botWorkspacesStore(db), readPressure: options.readPressure }));
}
