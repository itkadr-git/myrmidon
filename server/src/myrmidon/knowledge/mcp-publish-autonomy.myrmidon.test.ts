import express from "express";
import request from "supertest";
import { defaultAutonomyMatrix, type AutonomyVerdict } from "@myrmidon/shared";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const agent = { type: "agent", source: "agent_key", agentId, companyId };
const board = { type: "board", source: "session", userId: "operator", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }] };
const revisionId = "rev-original";
const url = `/api/myrmidon/companies/${companyId}/knowledge/mcp`;

function setup(verdict: AutonomyVerdict, folderPath = "notes", actor: unknown = agent, parking: "present" | "absent" | "error" = "present") {
  const item = { id: "item-1", slug: `${folderPath}/page`, kind: "note", folderPath, status: "published", roles: [] };
  const mod = { get: vi.fn(async () => item), publish: vi.fn(async () => item) };
  const matrix = defaultAutonomyMatrix();
  matrix.defaults.knowledge_publish = "forbidden";
  matrix.rules = [{ role: "engineer", actionClass: "knowledge_publish", verdict }];
  const matrixFor = vi.fn(async () => matrix);
  const roleForAgent = vi.fn(async () => "engineer");
  const agentHasToolAccess = vi.fn(async () => true);
  const park = vi.fn(async () => {
    if (parking === "error") throw new Error("parking failed");
    return { actionRequestId: "card-1" };
  });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  server.use("/api", knowledgeMcpRoutes({
    moduleFor: () => mod,
    matrixFor,
    roleForAgent,
    agentHasToolAccess,
    ...(parking === "absent" ? {} : { parkPublishForApproval: park }),
  } as unknown as KnowledgeMcpDeps));
  server.use(errorHandler);
  const call = () => request(server).post(url).send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "knowledge_publish", arguments: { idOrSlug: item.slug, revisionId } } });
  return { call, item, mod, matrixFor, roleForAgent, agentHasToolAccess, park };
}

function expectSuccess(body: unknown, item: unknown) {
  const result = { item };
  expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
}

function expectApproval(body: unknown, id: string | null) {
  expect(body).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `knowledge_publish outside the auto sections requires approval. Card ${id ?? "(unavailable)"} parked.`, data: { code: { code: "knowledge_approval_required", actionRequestId: id } } } });
}

describe("knowledge MCP publish autonomy", () => {
  it("auto sections bypass a forbidden matrix and parking", async () => {
    const s = setup("forbidden", "glossary/subsection");
    const response = await s.call();
    expect(response.status).toBe(200);
    expectSuccess(response.body, s.item);
    expect(s.agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ agentId, companyId, toolName: "knowledge_publish" });
    expect(s.matrixFor).not.toHaveBeenCalled();
    expect(s.roleForAgent).not.toHaveBeenCalled();
    expect(s.park).not.toHaveBeenCalled();
    expect(s.mod.publish).toHaveBeenCalledExactlyOnceWith(s.item.slug, { actorType: "agent", actorId: agentId }, revisionId);
  });

  it("forbidden outside auto refuses without parking or publishing", async () => {
    const s = setup("forbidden");
    const response = await s.call();
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32604, message: "knowledge_publish is forbidden for this actor by the autonomy matrix", data: { code: { code: "autonomy_forbidden" } } } });
    expect(s.matrixFor).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(s.roleForAgent).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(s.park).not.toHaveBeenCalled();
    expect(s.mod.publish).not.toHaveBeenCalled();
  });

  it("approval required parks exactly one card and refuses publish", async () => {
    const s = setup("approval_required");
    const response = await s.call();
    expect(response.status).toBe(409);
    expectApproval(response.body, "card-1");
    expect(s.park).toHaveBeenCalledExactlyOnceWith({ companyId, agentId, actorLabel: `agent:${agentId}`, itemId: s.item.id, itemSlug: s.item.slug, revisionId, toolName: "knowledge_publish" });
    expect(s.mod.publish).not.toHaveBeenCalled();
  });

  it("allowed outside auto publishes the requested revision", async () => {
    const s = setup("allowed");
    const response = await s.call();
    expect(response.status).toBe(200);
    expectSuccess(response.body, s.item);
    expect(s.matrixFor).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(s.roleForAgent).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(s.park).not.toHaveBeenCalled();
    expect(s.mod.publish).toHaveBeenCalledExactlyOnceWith(s.item.slug, { actorType: "agent", actorId: agentId }, revisionId);
  });

  it("missing parking callback refuses with a null action request", async () => {
    const s = setup("approval_required", "notes", agent, "absent");
    const response = await s.call();
    expect(response.status).toBe(409);
    expectApproval(response.body, null);
    expect(s.park).not.toHaveBeenCalled();
    expect(s.mod.publish).not.toHaveBeenCalled();
  });

  it("parking errors do not publish", async () => {
    const s = setup("approval_required", "notes", agent, "error");
    const response = await s.call();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "parking failed" }], structuredContent: { code: "unknown" } } });
    expect(s.park).toHaveBeenCalledTimes(1);
    expect(s.mod.publish).not.toHaveBeenCalled();
  });

  it("board publishing bypasses agent grant and autonomy", async () => {
    const s = setup("forbidden", "notes", board);
    const response = await s.call();
    expect(response.status).toBe(200);
    expectSuccess(response.body, s.item);
    expect(s.agentHasToolAccess).not.toHaveBeenCalled();
    expect(s.matrixFor).not.toHaveBeenCalled();
    expect(s.roleForAgent).not.toHaveBeenCalled();
    expect(s.park).not.toHaveBeenCalled();
    expect(s.mod.publish).toHaveBeenCalledExactlyOnceWith(s.item.slug, { actorType: "user", actorId: "operator" }, revisionId);
  });
});
