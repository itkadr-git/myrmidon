import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_TOOL_ACCESS_DENIED_CODE } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { KnowledgeDomainError } from "./domain.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const base = `/api/myrmidon/companies/${companyId}/knowledge/suggestions`;
const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [companyId] };
const agent = { type: "agent", source: "agent_key", agentId, companyId, keyId: "key-a", companyIds: [companyId] };

function setup(actor: typeof board | typeof agent, grant = false) {
  const mod = {
    decideSuggestion: vi.fn(),
    suggest: vi.fn(),
    create: vi.fn(),
    publish: vi.fn(),
  };
  const moduleFor = vi.fn(() => mod);
  const agentHasToolAccess = vi.fn(async () => grant);
  const deps = { moduleFor, agentHasToolAccess } as unknown as KnowledgeRoutesDeps;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", knowledgeRoutes(deps));
  server.use(errorHandler);
  return { server, mod, moduleFor, agentHasToolAccess };
}

function noOtherWrites(mod: ReturnType<typeof setup>["mod"]) {
  expect(mod.suggest).not.toHaveBeenCalled();
  expect(mod.create).not.toHaveBeenCalled();
  expect(mod.publish).not.toHaveBeenCalled();
}

describe("knowledge REST suggestion decisions", () => {
  it.each([
    { name: "board accept", actor: board, endpoint: "accept", id: "suggestion-a", decision: "accepted", expectedActor: { actorType: "user", actorId: "user-a" } },
    { name: "board decline", actor: board, endpoint: "decline", id: "suggestion-b", decision: "declined", expectedActor: { actorType: "user", actorId: "user-a" } },
    { name: "agent accept", actor: agent, endpoint: "accept", id: "suggestion-b", decision: "accepted", expectedActor: { actorType: "agent", actorId: agentId } },
    { name: "agent decline", actor: agent, endpoint: "decline", id: "suggestion-a", decision: "declined", expectedActor: { actorType: "agent", actorId: agentId } },
  ])("attributes $name to the URL and returns the exact suggestion", async ({ actor, endpoint, id, decision, expectedActor }) => {
    const { server, mod, moduleFor, agentHasToolAccess } = setup(actor, true);
    const suggestion = { id, status: decision, body: `fixture for ${id}`, marker: endpoint };
    mod.decideSuggestion.mockResolvedValue(suggestion);
    const res = await request(server).post(`${base}/${id}/${endpoint}`).send({ reason: "Reviewed", decision: "other", suggestionId: "other" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestion });
    expect(moduleFor).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(mod.decideSuggestion).toHaveBeenCalledExactlyOnceWith(expectedActor, { suggestionId: id, decision });
    if (actor.type === "agent") {
      expect(agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ agentId, companyId, toolName: "knowledge_propose" });
    } else {
      expect(agentHasToolAccess).not.toHaveBeenCalled();
    }
    noOtherWrites(mod);
  });

  it.each(["accept", "decline"])("denies an agent without a grant on %s before any write", async (endpoint) => {
    const { server, mod, moduleFor, agentHasToolAccess } = setup(agent);
    const res = await request(server).post(`${base}/suggestion-a/${endpoint}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(KNOWLEDGE_TOOL_ACCESS_DENIED_CODE);
    expect(agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ agentId, companyId, toolName: "knowledge_propose" });
    expect(moduleFor).not.toHaveBeenCalled();
    expect(mod.decideSuggestion).not.toHaveBeenCalled();
    noOtherWrites(mod);
  });

  it.each([
    { endpoint: "accept", status: 404, code: "suggestion_not_found", decision: "accepted" },
    { endpoint: "decline", status: 409, code: "suggestion_conflict", decision: "declined" },
  ])("returns domain $status on $endpoint without a suggestion", async ({ endpoint, status, code, decision }) => {
    const { server, mod } = setup(board);
    mod.decideSuggestion.mockRejectedValue(new KnowledgeDomainError(code, status, "Decision refused"));
    const res = await request(server).post(`${base}/suggestion-b/${endpoint}`).send({});
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body).not.toHaveProperty("suggestion");
    expect(mod.decideSuggestion).toHaveBeenCalledExactlyOnceWith({ actorType: "user", actorId: "user-a" }, { suggestionId: "suggestion-b", decision });
    noOtherWrites(mod);
  });

  it("rejects invalid reason before accessing the decision port", async () => {
    const { server, mod, moduleFor } = setup(board);
    const res = await request(server).post(`${base}/suggestion-a/accept`).send({ reason: 42 });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("suggestion");
    expect(moduleFor).not.toHaveBeenCalled();
    expect(mod.decideSuggestion).not.toHaveBeenCalled();
    noOtherWrites(mod);
  });

  it("calls the decision port once per repeated HTTP request without a hidden retry", async () => {
    const { server, mod } = setup(board);
    const first = { id: "suggestion-a", status: "accepted", version: 1 };
    const second = { id: "suggestion-a", status: "accepted", version: 2 };
    mod.decideSuggestion.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const one = await request(server).post(`${base}/suggestion-a/accept`).send({});
    const two = await request(server).post(`${base}/suggestion-a/accept`).send({});
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.body).toEqual({ suggestion: first });
    expect(two.body).toEqual({ suggestion: second });
    expect(mod.decideSuggestion).toHaveBeenCalledTimes(2);
    expect(mod.decideSuggestion).toHaveBeenNthCalledWith(1, { actorType: "user", actorId: "user-a" }, { suggestionId: "suggestion-a", decision: "accepted" });
    expect(mod.decideSuggestion).toHaveBeenNthCalledWith(2, { actorType: "user", actorId: "user-a" }, { suggestionId: "suggestion-a", decision: "accepted" });
    noOtherWrites(mod);
  });
});
