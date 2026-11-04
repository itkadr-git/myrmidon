// myrmidon(1.6.5-OWNER-VIA-BOT): route tier of the owner dialogue.
//
// Checked: the owner-message endpoints are agent-only; the resolve endpoint
// hands the request to the ordinary interaction route with the OWNER as the
// acting board user (never the agent) and only after the guard proved the
// owner's answer; a refusing guard stops the request before any hand-over.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { ZodError } from "zod";
import { HttpError, forbidden } from "../../errors.js";

const mocks = vi.hoisted(() => ({
  sendOwnerMessage: vi.fn(),
  authorizeOwnerReplyResolution: vi.fn(),
  logActivity: vi.fn(async () => ({})),
}));

vi.mock("./owner-message.js", () => ({
  sendOwnerMessage: mocks.sendOwnerMessage,
  authorizeOwnerReplyResolution: mocks.authorizeOwnerReplyResolution,
}));
vi.mock("../../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

import { ownerDeliveryRoutes } from "./routes.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "owner-user-1";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const INTERACTION_ID = "55555555-5555-4555-8555-555555555555";
const COMMENT_ID = "66666666-6666-4666-8666-666666666666";

/** `db.select().from().where().limit()` resolving to one active membership row. */
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ membershipRole: "operator" }],
      }),
    }),
  }),
} as unknown as Db;

type Actor = Express.Request["actor"];
let actor: Actor;
const handedOver: Array<{ actor: Actor; body: unknown; params: Record<string, string> }> = [];

function buildApp(issueRouter?: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const api = express.Router();
  api.use(ownerDeliveryRoutes(fakeDb));
  if (issueRouter) {
    api.use(issueRouter);
  } else {
    // Production routing behavior for the ordinary interaction routes of the issue router.
    api.post("/issues/:id/interactions/:interactionId/:action", (req, res) => {
      const { id, interactionId, action } = req.params;
      if (id !== ISSUE_ID) {
        return res.status(404).json({ error: "Issue not found" });
      }
      if (interactionId !== INTERACTION_ID) {
        return res.status(404).json({ error: "Interaction not found" });
      }
      if (!["accept", "reject", "respond"].includes(action as string)) {
        return res.status(404).json({ error: "Action not found" });
      }
      handedOver.push({ actor: req.actor, body: req.body, params: req.params as Record<string, string> });
      res.json({ id: interactionId, status: "accepted", action });
    });
  }
  app.use("/api", api);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation error", details: err.issues });
      }
      const status = err instanceof HttpError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "error" });
    },
  );
  return app;
}

const agentActor = (): Actor => ({
  type: "agent",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  runId: RUN_ID,
  source: "agent_jwt",
});

const resolveBody = (overrides: Record<string, unknown> = {}) => ({
  interactionId: INTERACTION_ID,
  ownerReplyCommentId: COMMENT_ID,
  action: "accept",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  handedOver.length = 0;
  actor = agentActor();
  mocks.authorizeOwnerReplyResolution.mockResolvedValue({
    ownerUserId: OWNER_ID,
    issueId: ISSUE_ID,
    interactionId: INTERACTION_ID,
    action: "accept",
    conversationIssueId: "77777777-7777-4777-8777-777777777777",
    ownerReplyCommentId: COMMENT_ID,
  });
});

describe("myrmidon(1.6.5-OWNER-VIA-BOT) owner message routes", () => {
  it("keeps valid owner-message and resolve addresses on registered routes instead of returning 404", async () => {
    mocks.sendOwnerMessage.mockResolvedValue({
      commentId: COMMENT_ID,
      publicationId: "88888888-8888-4888-8888-888888888888",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      interactionIds: [INTERACTION_ID],
    });

    const app = buildApp();
    const message = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "Route regression check." });
    expect(message.status).toBe(201);

    const resolution = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody());
    expect(resolution.status).toBe(200);
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]!.params).toMatchObject({
      id: ISSUE_ID,
      interactionId: INTERACTION_ID,
      action: "accept",
    });
  });

  it("rejects an addressless request before it can fall through as a 404", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [], text: "No recipient" });

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(404);
    expect(mocks.sendOwnerMessage).not.toHaveBeenCalled();
  });

  it("propagates duplicate delivery rejection without creating another publication", async () => {
    const delivery = { interactionIds: [INTERACTION_ID], text: "Retry-safe explanation." };
    const publication = {
      commentId: COMMENT_ID,
      publicationId: "88888888-8888-4888-8888-888888888888",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      interactionIds: [INTERACTION_ID],
    };
    mocks.sendOwnerMessage
      .mockResolvedValueOnce(publication)
      .mockRejectedValueOnce(new HttpError(409, "The owner has already been notified"));
    const app = buildApp();

    const first = await request(app).post("/api/myrmidon/owner-message").send(delivery);
    const retry = await request(app).post("/api/myrmidon/owner-message").send(delivery);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "The owner has already been notified" });
    expect(mocks.sendOwnerMessage).toHaveBeenCalledTimes(2);
  });

  it("sends the owner message for the calling agent and run", async () => {
    mocks.sendOwnerMessage.mockResolvedValue({
      commentId: COMMENT_ID,
      publicationId: "88888888-8888-4888-8888-888888888888",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      interactionIds: [INTERACTION_ID],
    });
    const response = await request(buildApp())
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "Explanation for the owner." });
    expect(response.status).toBe(201);
    expect(response.body.commentId).toBe(COMMENT_ID);
    expect(mocks.sendOwnerMessage).toHaveBeenCalledWith(fakeDb, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      interactionIds: [INTERACTION_ID],
      text: "Explanation for the owner.",
    });
  });

  it("rejects invalid payload for owner message with 400 and does not 404", async () => {
    const app = buildApp();

    const emptyRes = await request(app).post("/api/myrmidon/owner-message").send({});
    expect(emptyRes.status).toBe(400);

    const emptyIdsRes = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [], text: "Hello" });
    expect(emptyIdsRes.status).toBe(400);

    const invalidIdRes = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: ["not-a-uuid"], text: "Hello" });
    expect(invalidIdRes.status).toBe(400);

    const emptyTextRes = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "   " });
    expect(emptyTextRes.status).toBe(400);

    const extraFieldsRes = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "Hello", unexpectedProp: "value" });
    expect(extraFieldsRes.status).toBe(400);

    expect(mocks.sendOwnerMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid payload for owner reply resolution with 400 and does not 404", async () => {
    const app = buildApp();

    const emptyRes = await request(app).post("/api/myrmidon/owner-message/resolve").send({});
    expect(emptyRes.status).toBe(400);

    const invalidIdRes = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody({ interactionId: "invalid-uuid" }));
    expect(invalidIdRes.status).toBe(400);

    const invalidActionRes = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody({ action: "escalate" }));
    expect(invalidActionRes.status).toBe(400);

    const extraFieldRes = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody({ extraProp: 123 }));
    expect(extraFieldRes.status).toBe(400);

    expect(mocks.authorizeOwnerReplyResolution).not.toHaveBeenCalled();
  });

  it("confirms route contract: registered owner message endpoint exists and does not 404, while unregistered path returns 404", async () => {
    mocks.sendOwnerMessage.mockResolvedValue({
      commentId: COMMENT_ID,
      publicationId: "88888888-8888-4888-8888-888888888888",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      interactionIds: [INTERACTION_ID],
    });
    const app = buildApp();

    // Registered owner-message route returns 201 (not 404)
    const validMessageRes = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "Route regression check." });
    expect(validMessageRes.status).toBe(201);

    // Registered resolve route returns 200 (not 404)
    const validResolveRes = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody());
    expect(validResolveRes.status).toBe(200);

    // Unregistered path returns 404
    const unregisteredPathRes = await request(app)
      .post("/api/myrmidon/owner-message/unregistered")
      .send({ interactionIds: [INTERACTION_ID], text: "Hello" });
    expect(unregisteredPathRes.status).toBe(404);

    // Unsupported method on registered route returns 404
    const unsupportedMethodRes = await request(app).get("/api/myrmidon/owner-message");
    expect(unsupportedMethodRes.status).toBe(404);
  });

  it("returns 404 JSON when owner reply resolution targets a missing issue or interaction", async () => {
    mocks.authorizeOwnerReplyResolution.mockResolvedValueOnce({
      ownerUserId: OWNER_ID,
      issueId: "missing-issue-id",
      interactionId: INTERACTION_ID,
      action: "accept",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      ownerReplyCommentId: COMMENT_ID,
    });
    const app = buildApp();

    const missingIssueResponse = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody());

    expect(missingIssueResponse.status).toBe(404);
    expect(missingIssueResponse.headers["content-type"]).toMatch(/application\/json/);
    expect(missingIssueResponse.body).toMatchObject({ error: "Issue not found" });
    expect(handedOver).toEqual([]);

    mocks.authorizeOwnerReplyResolution.mockResolvedValueOnce({
      ownerUserId: OWNER_ID,
      issueId: ISSUE_ID,
      interactionId: "99999999-9999-4999-8999-999999999999",
      action: "accept",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      ownerReplyCommentId: COMMENT_ID,
    });

    const missingInteractionResponse = await request(app)
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody({ interactionId: "99999999-9999-4999-8999-999999999999" }));

    expect(missingInteractionResponse.status).toBe(404);
    expect(missingInteractionResponse.headers["content-type"]).toMatch(/application\/json/);
    expect(missingInteractionResponse.body).toMatchObject({ error: "Interaction not found" });
    expect(handedOver).toEqual([]);
  });

  it("is agent-only: a board user can neither write to the owner nor resolve", async () => {
    actor = {
      type: "board",
      userId: OWNER_ID,
      source: "session",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    };
    const app = buildApp();
    const message = await request(app)
      .post("/api/myrmidon/owner-message")
      .send({ interactionIds: [INTERACTION_ID], text: "Hello" });
    expect(message.status).toBe(403);
    const resolve = await request(app).post("/api/myrmidon/owner-message/resolve").send(resolveBody());
    expect(resolve.status).toBe(403);
    expect(mocks.sendOwnerMessage).not.toHaveBeenCalled();
    expect(mocks.authorizeOwnerReplyResolution).not.toHaveBeenCalled();
    expect(handedOver).toEqual([]);
  });

  it("hands the accept over to the ordinary route as the owner, not as the agent", async () => {
    const response = await request(buildApp())
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: INTERACTION_ID, status: "accepted" });
    expect(mocks.authorizeOwnerReplyResolution).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ companyId: COMPANY_ID, agentId: AGENT_ID, runId: RUN_ID }),
    );
    expect(handedOver).toHaveLength(1);
    const [call] = handedOver;
    expect(call!.params).toMatchObject({ id: ISSUE_ID, interactionId: INTERACTION_ID, action: "accept" });
    expect(call!.actor).toMatchObject({
      type: "board",
      userId: OWNER_ID,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
      runId: RUN_ID,
    });
    expect(call!.actor.agentId).toBeUndefined();
    expect(call!.body).toEqual({});
    // The audit trail names the agent that carried the answer and the owner it was made by.
    expect(mocks.logActivity).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        actorType: "agent",
        actorId: AGENT_ID,
        action: "owner_reply.resolution",
        details: expect.objectContaining({
          interactionId: INTERACTION_ID,
          ownerReplyCommentId: COMMENT_ID,
          resolvedAsUserId: OWNER_ID,
        }),
      }),
    );
  });

  it("passes the respond body through to the question route", async () => {
    mocks.authorizeOwnerReplyResolution.mockResolvedValue({
      ownerUserId: OWNER_ID,
      issueId: ISSUE_ID,
      interactionId: INTERACTION_ID,
      action: "respond",
      conversationIssueId: "77777777-7777-4777-8777-777777777777",
      ownerReplyCommentId: COMMENT_ID,
    });
    const answers = [{ questionId: "deploy-window", optionIds: ["morning"] }];
    const response = await request(buildApp())
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody({ action: "respond", body: { answers } }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: INTERACTION_ID, action: "respond" });
    expect(handedOver[0]!.params.action).toBe("respond");
    expect(handedOver[0]!.body).toEqual({ answers });
  });

  it("does not hand anything over when the guard refuses the answer", async () => {
    mocks.authorizeOwnerReplyResolution.mockRejectedValue(forbidden("not the owner's answer"));
    const response = await request(buildApp())
      .post("/api/myrmidon/owner-message/resolve")
      .send(resolveBody());
    expect(response.status).toBe(403);
    expect(handedOver).toEqual([]);
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
