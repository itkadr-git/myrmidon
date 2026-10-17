// server/src/myrmidon/agent-exchange/feed-routes.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the owner-facing feed API.
//
//   GET   /api/myrmidon/companies/:companyId/agent-exchange/feed
//         (company access) the rooms of the company with their outcome, their
//         price tag and the link to the task.
//   POST  /api/myrmidon/companies/:companyId/agent-exchange/rooms/:roomId/skill-candidate
//         (board) the «to skill» button: the outcome of that room becomes a
//         candidate of SKILL-LIFECYCLE — never a promoted skill.
//   GET   /api/myrmidon/agent-exchange/feed/settings   (board org)
//   PATCH /api/myrmidon/agent-exchange/feed/settings   (instance admin)
//         the two switches of this part, with the source of each value.
//
// The settings live at the instance scope, exactly like the room settings of
// part A — the feed itself is company-scoped, because it reads the rooms of
// one company. The routes only authenticate, validate against the shared
// contract and translate the stable error codes; the logic is in feed.ts and
// skill-candidate.ts.

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentExchangeSkillCandidateSchema,
  type AgentExchangeSkillCandidateInput,
  type AgentExchangeFeedSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readAgentExchangeFeed, AgentExchangeFeedError, type AgentExchangeFeedStore } from "./feed.js";
import {
  createAgentExchangeRoomSkillCandidate,
  type AgentExchangeSkillCandidateActor,
  type AgentExchangeSkillCandidatePort,
  type AgentExchangeSkillCandidateStore,
} from "./skill-candidate.js";
import { readAgentExchangeFeedSettings, type AgentExchangeFeedSettingsDeps } from "./feed-settings.js";

export interface AgentExchangeFeedRoutesDeps {
  db: Db;
  store: AgentExchangeFeedStore;
  skillCandidateStore: AgentExchangeSkillCandidateStore;
  skillCandidatePort: AgentExchangeSkillCandidatePort;
  /** Writes the stored feed settings (instance scope, merged by the caller). */
  updateSettings(patch: AgentExchangeFeedSettingsPatch): Promise<unknown>;
}

function settingsDeps(deps: AgentExchangeFeedRoutesDeps): AgentExchangeFeedSettingsDeps {
  const svc = instanceSettingsService(deps.db);
  return { getGeneral: () => svc.getGeneral() as Promise<{ agentExchangeFeed?: unknown }> };
}

function actorOf(req: Request): AgentExchangeSkillCandidateActor {
  const actor = getActorInfo(req);
  return { actorType: actor.actorType, actorId: actor.actorId };
}

/** Map the domain refusals onto HTTP: a missing room is a 404, the rest a 422. */
function sendFeedError(res: Response, error: unknown): void {
  if (error instanceof AgentExchangeFeedError) {
    const status = error.code === "room_not_found" ? 404 : 422;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

export function agentExchangeFeedRoutes(deps: AgentExchangeFeedRoutesDeps): Router {
  const router = Router();
  const settingsPath = "/myrmidon/agent-exchange/feed/settings";
  const companyBase = "/myrmidon/companies/:companyId/agent-exchange";

  router.get(settingsPath, async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await readAgentExchangeFeedSettings(settingsDeps(deps)));
  });

  router.patch(settingsPath, async (req, res) => {
    assertInstanceAdmin(req);
    await deps.updateSettings(req.body as AgentExchangeFeedSettingsPatch);
    res.json(await readAgentExchangeFeedSettings(settingsDeps(deps)));
  });

  router.get(`${companyBase}/feed`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const resolved = await readAgentExchangeFeedSettings(settingsDeps(deps));
    res.json(
      await readAgentExchangeFeed(
        { store: deps.store },
        {
          companyId,
          limit: resolved.settings.feedLimit,
          skillCandidateEnabled: resolved.settings.skillCandidateEnabled,
        },
      ),
    );
  });

  router.post(
    `${companyBase}/rooms/:roomId/skill-candidate`,
    validate(agentExchangeSkillCandidateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const resolved = await readAgentExchangeFeedSettings(settingsDeps(deps));
      const body = req.body as AgentExchangeSkillCandidateInput;
      try {
        const result = await createAgentExchangeRoomSkillCandidate(
          {
            store: deps.skillCandidateStore,
            port: deps.skillCandidatePort,
            skillCandidateEnabled: resolved.settings.skillCandidateEnabled,
          },
          {
            companyId,
            roomId: req.params.roomId as string,
            actor: actorOf(req),
            name: body.name ?? null,
            note: body.note ?? null,
          },
        );
        // 201 when this call registered the candidate, 200 when the room
        // already had one (the button is idempotent).
        res.status(result.created ? 201 : 200).json(result);
      } catch (error) {
        sendFeedError(res, error);
      }
    },
  );

  return router;
}