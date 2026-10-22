// server/src/myrmidon/agent-exchange/routes.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the discussion-room API.
//
//   GET    /api/myrmidon/agent-exchange/settings        — resolved settings + sources
//   PATCH  /api/myrmidon/agent-exchange/settings        — instance-admin write
//   POST   /api/myrmidon/agent-exchange/rooms           — open a room (runs round 1)
//   GET    /api/issues/:issueId/agent-exchange/rooms    — the rooms of a task
//   GET    /api/myrmidon/agent-exchange/rooms/:roomId   — room + transcript
//   POST   /api/myrmidon/agent-exchange/rooms/:roomId/rounds   — run the next round
//   POST   /api/myrmidon/agent-exchange/rooms/:roomId/finalize — finisher + summary
//   POST   /api/myrmidon/agent-exchange/rooms/:roomId/stop     — the stop valve
//
// The engine decides everything; the routes only authenticate, validate the
// body against the shared contract and translate the stable error codes.

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentExchangeCreateRoomSchema,
  agentExchangeStopSchema,
  patchAgentExchangeSettingsSchema,
  type AgentExchangeCreateRoomInput,
  type AgentExchangeStopInput,
  type AgentExchangeSettingsPatch,
} from "@paperclipai/shared";
import { issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { notFound } from "../../errors.js";
import { readAgentExchangeSettings, type AgentExchangeSettingsDeps } from "./settings.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import {
  AgentExchangeError,
  finalizeRoom,
  getRoom,
  openRoom,
  runNextRound,
  stopRoom,
  type AgentExchangeEngineDeps,
  type AgentExchangeStore,
} from "./engine.js";

export interface AgentExchangeRoutesDeps {
  db: Db;
  store: AgentExchangeStore;
  /** Builds engine deps for one company (settings resolved per request). */
  engineDeps(companyId: string, settings: Awaited<ReturnType<typeof readAgentExchangeSettings>>): AgentExchangeEngineDeps;
  updateSettings(patch: AgentExchangeSettingsPatch): Promise<unknown>;
}

function settingsDeps(deps: AgentExchangeRoutesDeps): AgentExchangeSettingsDeps {
  const svc = instanceSettingsService(deps.db);
  return { getGeneral: () => svc.getGeneral() };
}

function actorOf(req: Request): { actorType: "user" | "agent"; actorId: string } {
  const actor = getActorInfo(req);
  return { actorType: actor.actorType, actorId: actor.actorId };
}

function sendEngineError(res: { status: (n: number) => { json: (b: unknown) => void } }, error: unknown): void {
  if (error instanceof AgentExchangeError) {
    const status =
      error.code === "room_not_found"
        ? 404
        : error.code === "feature_disabled" || error.code === "too_many_participants" || error.code === "token_budget_exhausted"
          ? 422
          : error.code === "not_room_stopper"
            ? 403
            : 409;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

export function agentExchangeRoutes(deps: AgentExchangeRoutesDeps): Router {
  const router = Router();

  router.get("/myrmidon/agent-exchange/settings", async (_req, res) => {
    assertBoardOrgAccess(_req);
    res.json(await readAgentExchangeSettings(settingsDeps(deps)));
  });

  router.patch(
    "/myrmidon/agent-exchange/settings",
    validate(patchAgentExchangeSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      await deps.updateSettings(req.body as AgentExchangeSettingsPatch);
      res.json(await readAgentExchangeSettings(settingsDeps(deps)));
    },
  );

  router.post(
    "/myrmidon/agent-exchange/rooms",
    validate(agentExchangeCreateRoomSchema),
    async (req, res) => {
      const actor = actorOf(req);
      const input = req.body as AgentExchangeCreateRoomInput;
      const issue = await deps.db
        .select({ id: issues.id, companyId: issues.companyId, title: issues.title })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);

      const resolved = await readAgentExchangeSettings(settingsDeps(deps));
      const engine = deps.engineDeps(issue.companyId, resolved);
      try {
        const room = await openRoom(engine, {
          companyId: issue.companyId,
          issueId: issue.id,
          openerType: actor.actorType,
          openerId: actor.actorId,
          participants: input.participants.map((p) => ({
            agentId: p.agentId ?? null,
            label: p.label,
            providerId: p.providerId,
            model: p.model,
          })),
          finisher: input.finisher ?? null,
          maxRounds: input.maxRounds,
          tokenBudget: input.tokenBudget,
          prompt: input.prompt ?? issue.title,
          issueTitle: issue.title,
        });
        res.status(201).json(room);
      } catch (error) {
        sendEngineError(res, error);
      }
    },
  );

  router.get("/issues/:issueId/agent-exchange/rooms", async (req, res) => {
    const issue = await deps.db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, req.params.issueId as string))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    res.json(await deps.store.listRooms(issue.companyId, issue.id));
  });

  router.get("/myrmidon/agent-exchange/rooms/:roomId", async (req, res) => {
    assertBoardOrgAccess(req);
    try {
      res.json(await getRoom(deps.store, req.params.roomId as string));
    } catch (error) {
      sendEngineError(res, error);
    }
  });

  router.post("/myrmidon/agent-exchange/rooms/:roomId/rounds", async (req, res) => {
    const existing = await getRoom(deps.store, req.params.roomId as string).catch((error: unknown) => {
      sendEngineError(res, error);
      return null;
    });
    if (!existing) return;
    assertCompanyAccess(req, existing.room.companyId);
    const resolved = await readAgentExchangeSettings(settingsDeps(deps));
    const engine = deps.engineDeps(existing.room.companyId, resolved);
    const issue = await deps.db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, existing.room.issueId))
      .then((rows) => rows[0] ?? null);
    try {
      res.json(await runNextRound(engine, req.params.roomId, `Task: ${issue?.title ?? ""}`));
    } catch (error) {
      sendEngineError(res, error);
    }
  });

  router.post("/myrmidon/agent-exchange/rooms/:roomId/finalize", async (req, res) => {
    const existing = await getRoom(deps.store, req.params.roomId as string).catch((error: unknown) => {
      sendEngineError(res, error);
      return null;
    });
    if (!existing) return;
    assertCompanyAccess(req, existing.room.companyId);
    const resolved = await readAgentExchangeSettings(settingsDeps(deps));
    const engine = deps.engineDeps(existing.room.companyId, resolved);
    try {
      res.json(await finalizeRoom(engine, req.params.roomId as string));
    } catch (error) {
      sendEngineError(res, error);
    }
  });

  router.post(
    "/myrmidon/agent-exchange/rooms/:roomId/stop",
    validate(agentExchangeStopSchema),
    async (req, res) => {
      const actor = actorOf(req);
      const input = req.body as AgentExchangeStopInput;
      const existing = await getRoom(deps.store, req.params.roomId as string).catch((error: unknown) => {
        sendEngineError(res, error);
        return null;
      });
      if (!existing) return;
      assertCompanyAccess(req, existing.room.companyId);
      const resolved = await readAgentExchangeSettings(settingsDeps(deps));
      const engine = deps.engineDeps(existing.room.companyId, resolved);
      try {
        res.json(
          await stopRoom(engine, {
            roomId: req.params.roomId as string,
            actorType: actor.actorType,
            actorId: actor.actorId,
            finalize: input.finalize,
          }),
        );
      } catch (error) {
        sendEngineError(res, error);
      }
    },
  );

  return router;
}
