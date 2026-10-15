// server/src/myrmidon/owner-delivery/routes.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): the owner-DM delivery filter settings API.
//
// - GET /api/myrmidon/owner-delivery — the settings object `{ mode }`; any
//   authenticated board member may read it (part B renders the toggle from it).
// - PATCH /api/myrmidon/owner-delivery — write the mode; instance admin only,
//   the same rule the other instance settings follow.
//
// myrmidon(1.6.5-OWNER-VIA-BOT): the owner dialogue of the `via_bot` mode.
//
// - POST /api/myrmidon/owner-message — an agent writes the owner one DM that
//   explains its own open owner decisions (agent only, author only).
// - POST /api/myrmidon/owner-message/resolve — the agent closes such an
//   interaction from the owner's explicit text answer. The guard
//   (authorizeOwnerReplyResolution) proves the answer, then the request is
//   handed on to the ordinary accept / reject / respond route of the issue
//   router with the OWNER as the acting board user, so every side effect of
//   an owner's click (activity, continuation wake, answer delivery) is the
//   one the board already implements — the agent never resolves as itself.

import { and, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { companyMemberships, type Db } from "@paperclipai/db";
import {
  ownerDeliverySettingsSchema,
  ownerMessageRequestSchema,
  ownerReplyResolutionSchema,
  type OwnerMessageRequest,
  type OwnerReplyResolution,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { authorizeOwnerReplyResolution, sendOwnerMessage } from "./owner-message.js";
import {
  readOwnerDeliverySettings,
  writeOwnerDeliverySettings,
} from "./settings.js";

/** The calling agent of an owner-message request; anything else is refused. */
function requireAgentActor(req: Request) {
  const { actor } = req;
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    throw forbidden("Only an agent can use the owner message channel");
  }
  return {
    agentId: actor.agentId,
    companyId: actor.companyId,
    runId: actor.runId?.trim() || null,
  };
}

export function ownerDeliveryRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/owner-delivery", async (_req, res) => {
    assertBoardOrgAccess(_req);
    res.json(await readOwnerDeliverySettings(settings));
  });

  router.patch(
    "/myrmidon/owner-delivery",
    validate(ownerDeliverySettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await writeOwnerDeliverySettings(settings, req.body));
    },
  );

  router.post(
    "/myrmidon/owner-message",
    validate(ownerMessageRequestSchema),
    async (req, res) => {
      const agent = requireAgentActor(req);
      const body = req.body as OwnerMessageRequest;
      const result = await sendOwnerMessage(db, {
        companyId: agent.companyId,
        agentId: agent.agentId,
        runId: agent.runId,
        interactionIds: body.interactionIds,
        text: body.text,
      });
      res.status(201).json(result);
    },
  );

  router.post(
    "/myrmidon/owner-message/resolve",
    validate(ownerReplyResolutionSchema),
    async (req, res, next) => {
      const agent = requireAgentActor(req);
      const resolution = req.body as OwnerReplyResolution;
      const authorization = await authorizeOwnerReplyResolution(db, {
        companyId: agent.companyId,
        agentId: agent.agentId,
        runId: agent.runId,
        resolution,
      });
      // The owner must still be an active, writing member of the company: the
      // issue router checks the acting user's membership like any board click.
      const [membership] = await db
        .select({ membershipRole: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, agent.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, authorization.ownerUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (!membership) throw forbidden("The owner is not an active member of this company");
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "agent",
        actorId: agent.agentId,
        agentId: agent.agentId,
        runId: agent.runId,
        action: "owner_reply.resolution",
        entityType: "issue",
        entityId: authorization.issueId,
        details: {
          interactionId: authorization.interactionId,
          action: authorization.action,
          ownerReplyCommentId: authorization.ownerReplyCommentId,
          conversationIssueId: authorization.conversationIssueId,
          resolvedAsUserId: authorization.ownerUserId,
        },
      });
      // Hand over to the ordinary interaction route as the owner.
      req.actor = {
        type: "board",
        userId: authorization.ownerUserId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [agent.companyId],
        memberships: [
          {
            companyId: agent.companyId,
            membershipRole: membership.membershipRole,
            status: "active",
          },
        ],
        ...(agent.runId ? { runId: agent.runId } : {}),
      };
      req.url = `/issues/${authorization.issueId}/interactions/${authorization.interactionId}/${authorization.action}`;
      req.body = resolution.body ?? {};
      next();
    },
  );

  return router;
}
