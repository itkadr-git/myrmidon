// server/src/myrmidon/channel-allowlist/routes.ts
//
// myrmidon(CA-A): the board surface of the channel allowlist —
// GET/POST/PATCH /api/myrmidon/channel-allowlist. Board-only (the owner's
// setting: who may write to the bots is a governance decision, agents must
// not admit themselves), company-scoped the same way the access-hub wire
// contract resolves it (query parameter first, then the single membership).

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  channelAllowedUserCreateSchema,
  channelAllowedUserUpdateSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import type { ChannelAllowlistService } from "./service.js";

function resolveCompanyId(req: Request): string {
  assertBoard(req);
  const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
  if (fromQuery) {
    assertCompanyAccess(req, fromQuery);
    return fromQuery;
  }
  const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) {
    const ids = actor.companyIds ?? [];
    if (ids.length === 1) return ids[0];
    throw unprocessable("companyId query parameter is required");
  }
  const ids = actor.companyIds ?? [];
  if (ids.length === 1) return ids[0];
  throw unprocessable(
    ids.length === 0
      ? "companyId query parameter is required (no company membership)"
      : "companyId query parameter is required (multiple company memberships)",
  );
}

export function channelAllowlistRoutes(db: Db, service: ChannelAllowlistService) {
  void db; // the service holds the handle; the parameter keeps the factory shape uniform
  const router = Router();

  router.get("/myrmidon/channel-allowlist", async (req, res) => {
    const companyId = resolveCompanyId(req);
    res.json({ allowedUsers: await service.list(companyId) });
  });

  router.post("/myrmidon/channel-allowlist", async (req, res) => {
    const companyId = resolveCompanyId(req);
    const parsed = channelAllowedUserCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid allowlist entry", details: parsed.error.issues });
      return;
    }
    const actor = getActorInfo(req);
    const created = await service.create(
      companyId,
      {
        provider: parsed.data.provider,
        externalId: parsed.data.externalId,
        handle: parsed.data.handle ?? null,
        displayName: parsed.data.displayName ?? null,
        scope: parsed.data.scope,
        endpointId: parsed.data.endpointId ?? null,
        boardUserId: parsed.data.boardUserId ?? null,
      },
      { userId: actor.actorType === "user" ? actor.actorId : null },
    );
    res.status(201).json({ allowedUser: created });
  });

  router.patch("/myrmidon/channel-allowlist/:id", async (req, res) => {
    const companyId = resolveCompanyId(req);
    const parsed = channelAllowedUserUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid allowlist patch", details: parsed.error.issues });
      return;
    }
    const actor = getActorInfo(req);
    const updated = await service.update(
      companyId,
      req.params.id,
      parsed.data,
      { userId: actor.actorType === "user" ? actor.actorId : null },
    );
    res.json({ allowedUser: updated });
  });

  return router;
}
