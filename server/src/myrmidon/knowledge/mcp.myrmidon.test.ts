// myrmidon(1.6.6 K-3): the grade gate on the knowledge MCP surface.
//
// `knowledge_publish` is the one tool here that publishes (delivers) a rule, so
// it passes the same grade check as the REST routes. The tool list is pinned:
// a new tool that publishes, withdraws or re-roles a rule must be added to
// GRADED_TOOLS (and gated) on purpose.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { KNOWLEDGE_MCP_TOOL_NAMES, knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const operator = {
  type: "board",
  source: "session",
  userId: "user-op",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "operator" }],
};
const owner = { ...operator, userId: "user-owner", isInstanceAdmin: true };
const viewer = { ...operator, userId: "user-viewer", memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }] };

function ruleItem(roles: string[]) {
  return { id: "item-1", slug: "rules/smm/publications", kind: "rule", folderPath: "rules/smm", status: "published", roles };
}

function makeModule(item: ReturnType<typeof ruleItem>) {
  return {
    get: vi.fn(async () => item),
    publish: vi.fn(async () => item),
    create: vi.fn(async () => item),
    draft: vi.fn(async () => ({ id: "rev-2" })),
    submit: vi.fn(async () => item),
    suggest: vi.fn(async () => ({ id: "sug-1" })),
  };
}

function app(actor: unknown, mod: ReturnType<typeof makeModule>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    knowledgeMcpRoutes({
      moduleFor: () => mod,
      casteSensitivity: async () => ({ sensitive: new Set(["smm"]) }),
    } as unknown as KnowledgeMcpDeps),
  );
  server.use(errorHandler);
  return server;
}

const url = `/api/myrmidon/companies/${COMPANY_ID}/knowledge/mcp`;
const call = (actor: unknown, mod: ReturnType<typeof makeModule>, name: string, args: Record<string, unknown>) =>
  request(app(actor, mod)).post(url).send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("myrmidon(1.6.6 K-3) knowledge MCP: rule grade", () => {
  it("knowledge_publish of an old approved revision of a smm rule: operator 403, owner 200", async () => {
    const mod = makeModule(ruleItem(["smm"]));
    const args = { idOrSlug: "rules/smm/publications", revisionId: "rev-old-approved" };

    const refused = await call(operator, mod, "knowledge_publish", args);
    expect(refused.status).toBe(403);
    expect(mod.publish).not.toHaveBeenCalled();

    const allowed = await call(owner, mod, "knowledge_publish", args);
    expect(allowed.status).toBe(200);
    expect(allowed.body.error).toBeUndefined();
    expect(mod.publish).toHaveBeenCalledTimes(1);
    expect(mod.publish).toHaveBeenCalledWith("rules/smm/publications", expect.anything(), "rev-old-approved");
  });

  it("knowledge_publish of a rule of an ordinary caste passes for an operator; a viewer has no grade", async () => {
    const mod = makeModule(ruleItem(["engineer"]));
    const args = { idOrSlug: "rules/smm/publications", revisionId: "rev-1" };
    expect((await call(operator, mod, "knowledge_publish", args)).status).toBe(200);
    expect(mod.publish).toHaveBeenCalledTimes(1);
    expect((await call(viewer, mod, "knowledge_publish", args)).status).toBe(403);
    expect(mod.publish).toHaveBeenCalledTimes(1);
  });

  it("a note is not graded", async () => {
    const mod = makeModule({ ...ruleItem(["smm"]), kind: "note", folderPath: "notes" });
    expect((await call(operator, mod, "knowledge_publish", { idOrSlug: "notes/x" })).status).toBe(200);
  });

  it("the tool list is pinned: only knowledge_publish publishes, nothing approves, rolls back, archives, supersedes or imports", () => {
    const GRADED_TOOLS = ["knowledge_publish"];
    const UNGRADED_TOOLS = [
      "knowledge_search",
      "knowledge_read",
      "knowledge_list",
      "knowledge_backlinks",
      "knowledge_propose",
      "rule_propose",
      "knowledge_write_draft", // drafts and submits only: never delivers, never sets roles
    ];
    expect([...KNOWLEDGE_MCP_TOOL_NAMES].sort()).toEqual([...GRADED_TOOLS, ...UNGRADED_TOOLS].sort());
  });
});
