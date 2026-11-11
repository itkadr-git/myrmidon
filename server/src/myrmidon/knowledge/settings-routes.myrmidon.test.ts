// server/src/myrmidon/knowledge/settings-routes.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): unit tests for Knowledge Settings HTTP routes.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveKnowledgeSettings } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import type { KnowledgeSettingsService } from "./settings.js";
import { myrmidonKnowledgeSettingsRoutes } from "./settings-routes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(options?: {
  isInstanceAdmin?: boolean;
  actorType?: "board" | "agent";
  service?: Partial<KnowledgeSettingsService>;
}) {
  const defaultView = resolveKnowledgeSettings({});
  const read = vi.fn(async () => defaultView);
  const update = vi.fn(async (_companyId, _patch, _actor) => defaultView);
  const service: KnowledgeSettingsService = {
    read,
    update,
    ...options?.service,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (options?.actorType === "agent") {
      (req as any).actor = {
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        companyId: COMPANY_ID,
        keyId: "key-1",
        companyIds: [COMPANY_ID],
      };
    } else {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: "user-1",
        isInstanceAdmin: options?.isInstanceAdmin ?? true,
        companyIds: [COMPANY_ID],
        memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "admin" }],
      };
    }
    next();
  });

  app.use("/api", myrmidonKnowledgeSettingsRoutes(null as unknown as Db, {}, service));
  app.use(errorHandler);

  return { app, read, update };
}

describe("myrmidonKnowledgeSettingsRoutes", () => {
  it("GET returns resolved settings view for authorized company member", async () => {
    const { app, read } = makeApp({ isInstanceAdmin: false });
    const res = await request(app).get(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/settings`);

    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(COMPANY_ID);
    expect(res.body.maxItems.value).toBe(5000);
    expect(res.body.maxItems.source).toBe("default");
  });

  it("PATCH rejects non-admin board member with 403", async () => {
    const { app, update } = makeApp({ isInstanceAdmin: false });
    const res = await request(app)
      .patch(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/settings`)
      .send({ maxItems: "100" });

    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("PATCH rejects malformed field types with 400 before reaching service", async () => {
    const { app, update } = makeApp();
    const res = await request(app)
      .patch(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/settings`)
      .send({ maxItems: 123, autoAcceptEnabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(update).not.toHaveBeenCalled();
  });

  it("PATCH rejects unknown fields with 400 (strict schema)", async () => {
    const { app, update } = makeApp();
    const res = await request(app)
      .patch(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/settings`)
      .send({ maxItems: "100", unknownField: "extra" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(update).not.toHaveBeenCalled();
  });

  it("PATCH parses and trims valid body before calling service.update", async () => {
    const { app, update } = makeApp();
    const res = await request(app)
      .patch(`/api/myrmidon/companies/${COMPANY_ID}/knowledge/settings`)
      .send({
        maxItems: " 250 ",
        autoAcceptEnabled: true,
        schedule: " 0 3 * * * ",
      });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      COMPANY_ID,
      {
        maxItems: "250",
        autoAcceptEnabled: true,
        schedule: "0 3 * * *",
      },
      expect.objectContaining({ actorType: "user", actorId: "user-1" }),
    );
  });
});
