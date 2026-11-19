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
const board = {
  type: "board", source: "session", userId: "user-a", isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "operator" }],
};
const agent = {
  type: "agent", source: "agent_key", agentId, companyId, keyId: "key-a", companyIds: [companyId],
};
const rows = [
  { id: "suggestion-1", status: "pending", body: "First suggestion", extra: { source: "task-a" } },
  { id: "suggestion-2", status: "accepted", body: "Second suggestion", extra: null },
];

function setup(actor: unknown = board, granted = false) {
  const listSuggestions = vi.fn(async (_status?: string) => rows);
  const moduleFor = vi.fn(() => ({ listSuggestions }));
  const agentHasToolAccess = vi.fn(async () => granted);
  const deps = { moduleFor, agentHasToolAccess } as unknown as KnowledgeRoutesDeps;
  const server = express();
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", knowledgeRoutes(deps));
  server.use(errorHandler);
  return { server, listSuggestions, moduleFor, agentHasToolAccess };
}

describe("Myrmidon suggestion status REST contract", () => {
  it.each([
    ["pending", "pending"],
    ["accepted", "accepted"],
    ["declined", "declined"],
    ["all", "all"],
    ["unknown", undefined],
  ])("passes status %s as %s", async (query, expected) => {
    const { server, listSuggestions, moduleFor, agentHasToolAccess } = setup();
    const response = await request(server).get(base).query({ status: query });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ suggestions: rows });
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    expect(listSuggestions).toHaveBeenCalledTimes(1);
    expect(listSuggestions).toHaveBeenCalledWith(expected);
    expect(agentHasToolAccess).not.toHaveBeenCalled();
  });

  it("passes undefined for an omitted status and preserves an empty result", async () => {
    const { server, listSuggestions, moduleFor } = setup();
    listSuggestions.mockResolvedValueOnce([]);
    const response = await request(server).get(base);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ suggestions: [] });
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    expect(listSuggestions).toHaveBeenCalledTimes(1);
    expect(listSuggestions).toHaveBeenCalledWith(undefined);
  });

  it("preserves a domain error status and code", async () => {
    const { server, listSuggestions, moduleFor } = setup();
    listSuggestions.mockRejectedValueOnce(new KnowledgeDomainError("knowledge_test_refusal", 409, "Suggestion unavailable"));
    const response = await request(server).get(base).query({ status: "pending" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("knowledge_test_refusal");
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    expect(listSuggestions).toHaveBeenCalledTimes(1);
    expect(listSuggestions).toHaveBeenCalledWith("pending");
  });

  it("allows an agent with the knowledge_list grant", async () => {
    const { server, listSuggestions, moduleFor, agentHasToolAccess } = setup(agent, true);
    const response = await request(server).get(base).query({ status: "accepted" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ suggestions: rows });
    expect(agentHasToolAccess).toHaveBeenCalledTimes(1);
    expect(agentHasToolAccess).toHaveBeenCalledWith({ agentId, companyId, toolName: "knowledge_list" });
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    expect(listSuggestions).toHaveBeenCalledTimes(1);
    expect(listSuggestions).toHaveBeenCalledWith("accepted");
  });

  it("denies an agent without the knowledge_list grant before calling the module", async () => {
    const { server, listSuggestions, moduleFor, agentHasToolAccess } = setup(agent, false);
    const response = await request(server).get(base).query({ status: "pending" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(KNOWLEDGE_TOOL_ACCESS_DENIED_CODE);
    expect(agentHasToolAccess).toHaveBeenCalledTimes(1);
    expect(agentHasToolAccess).toHaveBeenCalledWith({ agentId, companyId, toolName: "knowledge_list" });
    expect(moduleFor).not.toHaveBeenCalled();
    expect(listSuggestions).not.toHaveBeenCalled();
  });
});
