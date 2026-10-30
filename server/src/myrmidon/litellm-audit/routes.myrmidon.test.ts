// server/src/myrmidon/litellm-audit/routes.myrmidon.test.ts
//
// myrmidon(OPE-9857): route tests for LiteLLM audit list and safe rollback endpoints.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { litellmAuditRoutes } from "./routes.js";
import type { LiteLlmAuditService } from "./service.js";

describe("LiteLLM audit routes (OPE-9857)", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";

  function createApp(service: Partial<LiteLlmAuditService>, actorType = "board") {
    const app = express();
    app.use(express.json());
    // Simulate auth middleware
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = {
        type: actorType,
        id: "test-user-id",
        userId: "test-user-id",
        companyId,
      };
      next();
    });
    app.use(litellmAuditRoutes(service as LiteLlmAuditService));
    return app;
  }

  it("GET /myrmidon/companies/:companyId/litellm/audit returns audit entries", async () => {
    const mockList = vi.fn().mockResolvedValue([
      {
        id: "audit-1",
        companyId,
        category: "models",
        action: "model_provider_models_updated",
        entityId: "prov-1",
        actor: { type: "board", id: "user-1" },
        timestamp: "2026-10-02T12:00:00.000Z",
        before: { models: [] },
        after: { models: [] },
        summary: "Updated models",
        canRollback: true,
      },
    ]);

    const app = createApp({ list: mockList });
    const res = await request(app).get(`/myrmidon/companies/${companyId}/litellm/audit?category=models`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].action).toBe("model_provider_models_updated");
    expect(mockList).toHaveBeenCalledWith(companyId, { category: "models", limit: 50 });
  });

  it("POST /myrmidon/companies/:companyId/litellm/audit/:auditId/rollback rejects agent actors", async () => {
    const mockRollback = vi.fn();
    const app = createApp({ rollback: mockRollback }, "agent");

    const res = await request(app)
      .post(`/myrmidon/companies/${companyId}/litellm/audit/audit-1/rollback`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it("POST /myrmidon/companies/:companyId/litellm/audit/:auditId/rollback succeeds for board actor", async () => {
    const mockRollback = vi.fn().mockResolvedValue({
      success: true,
      auditId: "audit-1",
      restoredState: { models: [{ modelName: "gpt-4o", enabled: false }] },
      rollbackEntry: {
        id: "rollback-1",
        action: "litellm_audit_rollback",
      },
    });

    const app = createApp({ rollback: mockRollback }, "board");

    const res = await request(app)
      .post(`/myrmidon/companies/${companyId}/litellm/audit/audit-1/rollback`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        auditId: "audit-1",
      }),
      undefined,
    );
  });
});