import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const actor = {
  type: "board", source: "session", userId: "user-op", isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "operator" }],
};
const revision = { id: "revision-returned" };
const item = { id: "item-1", slug: "ops/runbook" };
const sources = [{ kind: "task", ref: "TASK-123", note: "source" }];

function setup() {
  const mod = {
    draft: vi.fn(async () => revision),
    submit: vi.fn(async () => item),
    create: vi.fn(async () => item),
    publish: vi.fn(async () => item),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", knowledgeMcpRoutes({
    moduleFor: () => mod,
    casteSensitivity: async () => ({ sensitive: new Set<string>() }),
  } as unknown as KnowledgeMcpDeps));
  app.use(errorHandler);
  const call = (args: Record<string, unknown>) => request(app)
    .post(`/api/myrmidon/companies/${companyId}/knowledge/mcp`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "knowledge_write_draft", arguments: args } });
  return { mod, call };
}

function expectResult(body: unknown, result: unknown) {
  expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: {
    content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result,
  } });
}

describe("knowledge MCP draft and create branches", () => {
  it("forwards an existing draft and submits its returned revision in order", async () => {
    const { mod, call } = setup();
    const response = await call({ idOrSlug: "ops/runbook", content: "New content", changeSummary: "Update", sources, force: true, reason: "Urgent", submit: true });
    expect(response.status).toBe(200);
    expectResult(response.body, { item });
    expect(mod.draft).toHaveBeenCalledExactlyOnceWith("ops/runbook", { content: "New content", changeSummary: "Update", sources, force: true, reason: "Urgent" }, expect.anything());
    expect(mod.submit).toHaveBeenCalledExactlyOnceWith("ops/runbook", expect.anything(), revision.id);
    expect(mod.draft.mock.invocationCallOrder[0]).toBeLessThan(mod.submit.mock.invocationCallOrder[0]!);
    expect(mod.create).not.toHaveBeenCalled();
    expect(mod.publish).not.toHaveBeenCalled();
  });

  it.each([undefined, false, "true", 1, null])("does not submit for submit=%s", async (submit) => {
    const { mod, call } = setup();
    const response = await call({ idOrSlug: "ops/runbook", content: "Draft", submit });
    expect(response.status).toBe(200);
    expectResult(response.body, { revision });
    expect(mod.draft).toHaveBeenCalledExactlyOnceWith("ops/runbook", { content: "Draft", changeSummary: null, sources: undefined, force: false, reason: null }, expect.anything());
    expect(mod.submit).not.toHaveBeenCalled();
    expect(mod.create).not.toHaveBeenCalled();
    expect(mod.publish).not.toHaveBeenCalled();
  });

  it("does not submit if draft fails", async () => {
    const { mod, call } = setup();
    mod.draft.mockRejectedValueOnce(new Error("draft failed"));
    const response = await call({ idOrSlug: "ops/runbook", content: "Draft", submit: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "draft failed" }], structuredContent: { code: "unknown" } } });
    expect(mod.draft).toHaveBeenCalledTimes(1);
    expect(mod.submit).not.toHaveBeenCalled();
    expect(mod.create).not.toHaveBeenCalled();
    expect(mod.publish).not.toHaveBeenCalled();
  });

  it("creates with explicit fields without submitting or publishing", async () => {
    const { mod, call } = setup();
    const response = await call({ slug: "ops/new", title: "New", content: "Body", kind: "wiki", summary: "Summary", folderPath: "ops", tags: ["one"], approverKind: "agent", sources, force: true, reason: "Reason", submit: true });
    expect(response.status).toBe(200);
    expectResult(response.body, { item });
    expect(mod.create).toHaveBeenCalledExactlyOnceWith({ slug: "ops/new", title: "New", content: "Body", kind: "wiki", summary: "Summary", folderPath: "ops", tags: ["one"], approverKind: null, sources, force: true, reason: "Reason" }, expect.anything());
    expect(mod.draft).not.toHaveBeenCalled();
    expect(mod.submit).not.toHaveBeenCalled();
    expect(mod.publish).not.toHaveBeenCalled();
  });

  it("uses safe defaults for a new slug", async () => {
    const { mod, call } = setup();
    const response = await call({ slug: "new", content: "Body" });
    expect(response.status).toBe(200);
    expectResult(response.body, { item });
    expect(mod.create).toHaveBeenCalledExactlyOnceWith({ slug: "new", title: "Untitled", content: "Body", kind: "note", summary: null, folderPath: "", tags: [], approverKind: null, sources: undefined, force: false, reason: null }, expect.anything());
    expect(mod.draft).not.toHaveBeenCalled();
    expect(mod.submit).not.toHaveBeenCalled();
    expect(mod.publish).not.toHaveBeenCalled();
  });
});
