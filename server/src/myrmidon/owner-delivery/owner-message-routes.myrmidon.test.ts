// myrmidon(1.6.5-OWNER-VIA-BOT): route tier of the owner dialogue.
//
// Checked: the owner-message endpoints are agent-only; the resolve endpoint
// hands the request to the ordinary interaction route with the OWNER as the
// acting board user (never the agent) and only after the guard proved the
// owner's answer; a refusing guard stops the request before any hand-over.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const api = express.Router();
  api.use(ownerDeliveryRoutes(fakeDb));
  // The stand-in for the ordinary interaction routes of the issue router.
  api.post("/issues/:id/interactions/:interactionId/:action", (req, res) => {
    handedOver.push({ actor: req.actor, body: req.body, params: req.params as Record<string, string> });
    res.json({ handedOver: true });
  });
  app.use("/api", api);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
