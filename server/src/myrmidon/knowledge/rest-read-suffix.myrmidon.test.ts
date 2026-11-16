import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { KnowledgeDomainError } from "./domain.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const base = `/api/myrmidon/companies/${companyId}/knowledge/items`;
const itemId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";

function setup() {
  const ports = {
    get: vi.fn(async () => ({ id: "bare-item" })),
    listRevisions: vi.fn(async () => [{ id: "revision-list-result" }]),
    getRevision: vi.fn(async () => ({ id: "revision-result" })),
    backlinks: vi.fn(async () => [{ id: "backlink-result" }]),
  };
  const moduleFor = vi.fn(() => ports);
  const deps = { moduleFor } as unknown as KnowledgeRoutesDeps;
  const server = express();
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board", source: "session", userId: "user-a", isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
    };
    next();
  });
  server.use("/api", knowledgeRoutes(deps));
  server.use(errorHandler);
  return { server, ports, moduleFor };
}

describe("knowledge REST read suffix routing", () => {
  const cases = [
    { name: "nested revisions", path: "glossary/team/term/revisions", port: "listRevisions", args: ["glossary/team/term"], body: { revisions: [{ id: "revision-list-result" }] } },
    { name: "nested revision", path: `glossary/team/term/revisions/${revisionId}`, port: "getRevision", args: ["glossary/team/term", revisionId], body: { revision: { id: "revision-result" } } },
    { name: "nested backlinks", path: "glossary/team/term/backlinks", port: "backlinks", args: ["glossary/team/term"], body: { backlinks: [{ id: "backlink-result" }] } },
    { name: "UUID revisions", path: `${itemId}/revisions`, port: "listRevisions", args: [itemId], body: { revisions: [{ id: "revision-list-result" }] } },
    { name: "UUID revision", path: `${itemId}/revisions/${revisionId}`, port: "getRevision", args: [itemId, revisionId], body: { revision: { id: "revision-result" } } },
    { name: "UUID backlinks", path: `${itemId}/backlinks`, port: "backlinks", args: [itemId], body: { backlinks: [{ id: "backlink-result" }] } },
    { name: "encoded revisions", path: "glossary/team%20name/%D1%82%D0%B5%D1%80%D0%BC/revisions", port: "listRevisions", args: ["glossary/team name/\u0442\u0435\u0440\u043c"], body: { revisions: [{ id: "revision-list-result" }] } },
    { name: "encoded revision ID", path: "glossary/team%20name/%D1%82%D0%B5%D1%80%D0%BC/revisions/rev%20one", port: "getRevision", args: ["glossary/team name/\u0442\u0435\u0440\u043c", "rev one"], body: { revision: { id: "revision-result" } } },
    { name: "encoded backlinks", path: "glossary/team%20name/%D1%82%D0%B5%D1%80%D0%BC/backlinks", port: "backlinks", args: ["glossary/team name/\u0442\u0435\u0440\u043c"], body: { backlinks: [{ id: "backlink-result" }] } },
  ] as const;

  it.each(cases)("routes $name to only its matching port", async ({ path, port, args, body }) => {
    const { server, ports, moduleFor } = setup();
    const response = await request(server).get(`${base}/${path}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    for (const [name, mock] of Object.entries(ports)) {
      if (name === port) {
        expect(mock).toHaveBeenCalledTimes(1);
        expect(mock).toHaveBeenCalledWith(...args);
      } else {
        expect(mock).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps a bare nested item on the bare read path", async () => {
    const { server, ports } = setup();
    const response = await request(server).get(`${base}/glossary/team/term`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ item: { id: "bare-item", revisions: [{ id: "revision-list-result" }], backlinks: [{ id: "backlink-result" }] } });
    expect(ports.get).toHaveBeenCalledExactlyOnceWith("glossary/team/term");
    expect(ports.listRevisions).toHaveBeenCalledExactlyOnceWith("glossary/team/term");
    expect(ports.backlinks).toHaveBeenCalledExactlyOnceWith("glossary/team/term");
    expect(ports.getRevision).not.toHaveBeenCalled();
  });

  it("preserves domain error status and code without calling other ports", async () => {
    const { server, ports } = setup();
    ports.getRevision.mockRejectedValueOnce(new KnowledgeDomainError("revision_missing", 404, "Revision missing"));
    const response = await request(server).get(`${base}/glossary/team/term/revisions/${revisionId}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("revision_missing");
    expect(ports.getRevision).toHaveBeenCalledExactlyOnceWith("glossary/team/term", revisionId);
    expect(ports.get).not.toHaveBeenCalled();
    expect(ports.listRevisions).not.toHaveBeenCalled();
    expect(ports.backlinks).not.toHaveBeenCalled();
  });
});
