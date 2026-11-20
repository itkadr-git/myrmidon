import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const operator = {
  type: "board",
  source: "session",
  userId: "user-op",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "operator" }],
};

function setup() {
  const suggestion = { id: "sug-1" };
  const suggest = vi.fn(async () => suggestion);
  const moduleFor = vi.fn(() => ({ suggest }));
  let received: unknown;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = operator;
    received = req.body.params?.arguments;
    next();
  });
  app.use("/api", knowledgeMcpRoutes({ moduleFor, env: {} } as unknown as KnowledgeMcpDeps));
  app.use(errorHandler);
  const call = (name: string, args: Record<string, unknown>) =>
    request(app).post(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/mcp`).send({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
    });
  return { suggest, moduleFor, suggestion, call, received: () => received };
}

describe.each(["knowledge_propose", "rule_propose"])("%s sources and idempotency", (tool) => {
  it.each([
    ["absent", {}],
    ["null", { sources: null }],
    ["empty", { sources: [] }],
    ["non-array", { sources: "task" }],
  ])("rejects %s sources before suggest", async (_label, sources) => {
    const { call, suggest } = setup();
    const response = await call(tool, { body: "Proposal text", ...sources });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32000,
        message: tool === "knowledge_propose"
          ? "A knowledge proposal must name at least one source."
          : "A rule proposal must name at least one source.",
        data: { code: { code: "knowledge_propose_requires_sources", field: "sources" } },
      },
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it("forwards the first source, actor and idempotency key without changing the request", async () => {
    const { call, suggest, moduleFor, suggestion, received } = setup();
    const args = {
      targetSlug: "ops/runbook",
      title: "Improve the runbook",
      body: "Document the deployment steps.",
      sources: [{ kind: "task", ref: "TASK-123", note: "first" }, { kind: "pr", ref: "example/project#42" }],
      idempotencyKey: "idem-key",
    };
    const original = structuredClone(args);
    const response = await call(tool, args);
    expect(response.status).toBe(200);
    const result = { suggestion };
    expect(response.body).toEqual({
      jsonrpc: "2.0", id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
    });
    expect(moduleFor).toHaveBeenCalledExactlyOnceWith(COMPANY_ID);
    expect(suggest).toHaveBeenCalledExactlyOnceWith(
      { actorType: "user", actorId: "user-op" },
      { body: args.body, rationale: args.title, targetSlug: args.targetSlug, sourceKind: "task", sourceRef: "TASK-123", idempotencyKey: args.idempotencyKey },
    );
    expect(args).toEqual(original);
    expect(received()).toEqual(original);
  });

  it("rejects an invalid source kind before suggest", async () => {
    const { call, suggest } = setup();
    const response = await call(tool, { body: "Proposal text", sources: [{ kind: "invalid-kind", ref: "source" }] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jsonrpc: "2.0", id: 1,
      result: { isError: true, content: [{ type: "text", text: expect.any(String) }], structuredContent: { code: "unknown" } },
    });
    expect(response.body.result.content[0].text).toContain("kind");
    expect(suggest).not.toHaveBeenCalled();
  });
});
