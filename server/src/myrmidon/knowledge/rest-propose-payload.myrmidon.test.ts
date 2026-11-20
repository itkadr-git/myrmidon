import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const endpoint = `/api/myrmidon/companies/${companyId}/knowledge/propose`;
const agent = { type: "agent", source: "agent_key", agentId, companyId, keyId: "key-a", companyIds: [companyId] };
const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }] };

function setup(actor: unknown = agent, granted = true) {
  const suggestion = { id: "suggestion-a", status: "pending", body: "Stored result" };
  const suggest = vi.fn(async () => suggestion);
  const moduleFor = vi.fn(() => ({ suggest }));
  const agentHasToolAccess = vi.fn(async () => granted);
  const deps = { moduleFor, agentHasToolAccess, env: {} } as unknown as KnowledgeRoutesDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(deps));
  app.use(errorHandler);
  return { app, suggestion, suggest, moduleFor, agentHasToolAccess };
}

describe("knowledge REST proposal payload", () => {
  it("passes the complete agent payload and only the first source", async () => {
    const t = setup();
    const res = await request(t.app).post(endpoint).send({
      body: "A proposed change", title: "Reason A", targetSlug: "guides/alpha", idempotencyKey: "key-alpha",
      sources: [{ kind: "task", ref: "task-alpha" }, { kind: "url", ref: "https://example.com/beta" }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ suggestion: t.suggestion });
    expect(t.moduleFor).toHaveBeenCalledOnce();
    expect(t.moduleFor).toHaveBeenCalledWith(companyId);
    expect(t.agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ agentId, companyId, toolName: "knowledge_propose" });
    expect(t.suggest).toHaveBeenCalledExactlyOnceWith({ actorType: "agent", actorId: agentId }, {
      body: "A proposed change", rationale: "Reason A", targetSlug: "guides/alpha", sourceKind: "task", sourceRef: "task-alpha", idempotencyKey: "key-alpha",
    });
  });

  it("preserves absent optional fields as undefined for a board user", async () => {
    const t = setup(board);
    const res = await request(t.app).post(endpoint).send({ body: "Board proposal", sources: [{ kind: "document", ref: "doc-b" }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ suggestion: t.suggestion });
    expect(t.agentHasToolAccess).not.toHaveBeenCalled();
    expect(t.suggest).toHaveBeenCalledExactlyOnceWith({ actorType: "user", actorId: "user-a" }, {
      body: "Board proposal", rationale: undefined, targetSlug: undefined, sourceKind: "document", sourceRef: "doc-b", idempotencyKey: undefined,
    });
  });

  it("passes debate provenance unchanged", async () => {
    const t = setup();
    const res = await request(t.app).post(endpoint).send({ body: "Debate outcome", sources: [{ kind: "debate", ref: "debate-c" }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ suggestion: t.suggestion });
    expect(t.suggest).toHaveBeenCalledExactlyOnceWith({ actorType: "agent", actorId: agentId }, {
      body: "Debate outcome", rationale: undefined, targetSlug: undefined, sourceKind: "debate", sourceRef: "debate-c", idempotencyKey: undefined,
    });
  });

  it("passes the same idempotency key on each HTTP request", async () => {
    const t = setup();
    const payload = { body: "Repeat proposal", sources: [{ kind: "pr", ref: "pr-d" }], idempotencyKey: "repeat-d" };
    const first = await request(t.app).post(endpoint).send(payload);
    const second = await request(t.app).post(endpoint).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual({ suggestion: t.suggestion });
    expect(second.body).toEqual({ suggestion: t.suggestion });
    expect(t.suggest).toHaveBeenCalledTimes(2);
    const expected = { body: "Repeat proposal", rationale: undefined, targetSlug: undefined, sourceKind: "pr", sourceRef: "pr-d", idempotencyKey: "repeat-d" };
    expect(t.suggest).toHaveBeenNthCalledWith(1, { actorType: "agent", actorId: agentId }, expected);
    expect(t.suggest).toHaveBeenNthCalledWith(2, { actorType: "agent", actorId: agentId }, expected);
  });

  it("returns the port's distinct suggestion rather than a fixed response", async () => {
    const t = setup();
    t.suggest.mockResolvedValueOnce({ id: "suggestion-b", status: "other", body: "Different result" });
    const res = await request(t.app).post(endpoint).send({ body: "Another proposal", sources: [{ kind: "issue", ref: "issue-e" }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ suggestion: { id: "suggestion-b", status: "other", body: "Different result" } });
    expect(t.suggest).toHaveBeenCalledExactlyOnceWith({ actorType: "agent", actorId: agentId }, {
      body: "Another proposal", rationale: undefined, targetSlug: undefined, sourceKind: "issue", sourceRef: "issue-e", idempotencyKey: undefined,
    });
  });

  it("rejects missing sources before calling the port", async () => {
    const t = setup();
    const res = await request(t.app).post(endpoint).send({ body: "No source" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("knowledge_propose_requires_sources");
    expect(t.moduleFor).not.toHaveBeenCalled();
    expect(t.suggest).not.toHaveBeenCalled();
  });

  it("rejects an unknown source kind before calling the port", async () => {
    const t = setup();
    const res = await request(t.app).post(endpoint).send({ body: "Bad source", sources: [{ kind: "unknown", ref: "x" }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("knowledge_propose_invalid");
    expect(t.moduleFor).not.toHaveBeenCalled();
    expect(t.suggest).not.toHaveBeenCalled();
  });

  it("rejects an empty body before calling the port", async () => {
    const t = setup();
    const res = await request(t.app).post(endpoint).send({ body: "", sources: [{ kind: "task", ref: "task-f" }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("knowledge_propose_invalid");
    expect(t.moduleFor).not.toHaveBeenCalled();
    expect(t.suggest).not.toHaveBeenCalled();
  });

  it("does not call the port without the agent grant", async () => {
    const t = setup(agent, false);
    const res = await request(t.app).post(endpoint).send({ body: "Denied", sources: [{ kind: "task", ref: "task-g" }] });
    expect(res.status).toBe(403);
    expect(t.agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ agentId, companyId, toolName: "knowledge_propose" });
    expect(t.moduleFor).not.toHaveBeenCalled();
    expect(t.suggest).not.toHaveBeenCalled();
  });
});
