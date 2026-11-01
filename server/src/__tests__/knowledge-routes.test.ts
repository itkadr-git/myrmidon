import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const knowledgeMock = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  editSuggestion: vi.fn(),
  decideSuggestion: vi.fn(),
}));
const moduleMock = vi.hoisted(() => ({
  createKnowledgeModule: vi.fn(() => knowledgeMock),
}));

vi.mock("../myrmidon/knowledge/service.js", () => moduleMock);
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
}));

async function createApp() {
  const { myrmidonKnowledgeRoutes } = await import("../myrmidon/knowledge/routes.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "user-1", companyIds: ["company-1"] } as Express.Request["actor"];
    next();
  });
  app.use(myrmidonKnowledgeRoutes({} as never));
  return app;
}

describe("knowledge suggestion routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knowledgeMock.listSuggestions.mockResolvedValue([{ id: "suggestion-1", status: "pending" }]);
    knowledgeMock.editSuggestion.mockResolvedValue({ id: "suggestion-1", status: "pending" });
    knowledgeMock.decideSuggestion.mockResolvedValue({ id: "suggestion-1", status: "accepted" });
  });

  it("lists suggestions and routes edit, accept, and reject mutations", async () => {
    const app = await createApp();
    const base = "/myrmidon/companies/company-1/knowledge/suggestions";

    expect((await request(app).get(`${base}?status=pending`)).status).toBe(200);
    expect((await request(app).patch(`${base}/suggestion-1`).send({ body: "edited", rationale: "reason" })).status).toBe(200);
    expect((await request(app).post(`${base}/suggestion-1/decision`).send({ decision: "accepted" })).status).toBe(200);
    expect((await request(app).post(`${base}/suggestion-1/decision`).send({ decision: "declined", reason: "not applicable" })).status).toBe(200);

    expect(knowledgeMock.editSuggestion).toHaveBeenCalledWith(
      { actorType: "user", actorId: "user-1" },
      { suggestionId: "suggestion-1", body: "edited", rationale: "reason" },
    );
    expect(knowledgeMock.decideSuggestion).toHaveBeenNthCalledWith(1,
      { actorType: "user", actorId: "user-1" },
      { suggestionId: "suggestion-1", decision: "accepted", reason: undefined },
    );
    expect(knowledgeMock.decideSuggestion).toHaveBeenNthCalledWith(2,
      { actorType: "user", actorId: "user-1" },
      { suggestionId: "suggestion-1", decision: "declined", reason: "not applicable" },
    );
  });
});
