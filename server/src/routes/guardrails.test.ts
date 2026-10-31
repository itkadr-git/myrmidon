import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/error-handler.js";
import { guardrailsRoutes, encodeGuardrailCursor } from "./guardrails.js";
import {
  MOCK_GUARDRAIL_RULES,
  generateMockGuardrailRules,
  createMockGuardrailRule,
} from "../fixtures/guardrails.js";
import {
  listGuardrailRulesResponseSchema,
  type GuardrailRule,
} from "@myrmidon/shared";

function buildTestApp(actor: unknown, rules?: GuardrailRule[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", guardrailsRoutes(null as any, { rules }));
  app.use(errorHandler);
  return app;
}

const companyId = "c0000000-0000-0000-0000-000000000001";
const otherCompanyId = "c0000000-0000-0000-0000-000000000002";

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [companyId],
  isInstanceAdmin: true,
};

const companyAgentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId,
};

const crossCompanyAgentActor = {
  type: "agent",
  agentId: "agent-2",
  companyId: otherCompanyId,
};

const unauthenticatedActor = {
  type: "none",
};

describe("Guardrails Routes - OPE-10216", () => {
  describe("Authentication and Authorization (401 / 403)", () => {
    it("returns 401 for unauthenticated request on company-scoped endpoint", async () => {
      const app = buildTestApp(unauthenticatedActor);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules`)
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    it("returns 403 when an agent attempts to access a different company's guardrails", async () => {
      const app = buildTestApp(crossCompanyAgentActor);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules`)
        .expect(403);

      expect(res.body.error).toContain("cannot access another company");
    });

    it("returns 200 for company agent on own company route", async () => {
      const app = buildTestApp(companyAgentActor);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules`)
        .expect(200);

      expect(res.body.rules).toBeDefined();
    });

    it("returns 200 for board user on company route", async () => {
      const app = buildTestApp(boardActor);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules`)
        .expect(200);

      expect(res.body.rules).toBeDefined();
    });

    it("returns 401 for unauthenticated request on system endpoint", async () => {
      const app = buildTestApp(unauthenticatedActor);
      await request(app).get("/api/guardrails/rules").expect(401);
    });

    it("returns 403 for non-board actor on system endpoint", async () => {
      const app = buildTestApp(companyAgentActor);
      await request(app).get("/api/guardrails/rules").expect(403);
    });

    it("returns 200 for board actor on system endpoint", async () => {
      const app = buildTestApp(boardActor);
      const res = await request(app).get("/api/guardrails/rules").expect(200);
      expect(res.body.rules).toBeDefined();
    });
  });

  describe("Schema stability", () => {
    it("returns stable response conforming to listGuardrailRulesResponseSchema", async () => {
      const app = buildTestApp(boardActor, MOCK_GUARDRAIL_RULES);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules`)
        .expect(200);

      const parsed = listGuardrailRulesResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);

      const body = res.body;
      expect(Array.isArray(body.rules)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.rules.length).toBeGreaterThan(0);

      const firstRule = body.rules[0];
      expect(firstRule).toHaveProperty("id");
      expect(firstRule).toHaveProperty("name");
      expect(firstRule).toHaveProperty("type");
      expect(firstRule).toHaveProperty("status");
      expect(firstRule).toHaveProperty("mode");
      expect(firstRule).toHaveProperty("surface");
    });
  });

  describe("Filter validation and behavior", () => {
    const testRules: GuardrailRule[] = [
      createMockGuardrailRule({ id: "rule-1", type: "secret", status: "active" }),
      createMockGuardrailRule({ id: "rule-2", type: "secret", status: "disabled" }),
      createMockGuardrailRule({ id: "rule-3", type: "pii", status: "active" }),
      createMockGuardrailRule({ id: "rule-4", type: "injection", status: "draft" }),
      createMockGuardrailRule({ id: "rule-5", type: "regex", status: "archived" }),
    ];

    it("filters correctly by status", async () => {
      const app = buildTestApp(boardActor, testRules);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?status=active`)
        .expect(200);

      expect(res.body.rules).toHaveLength(2);
      expect(res.body.rules.every((r: GuardrailRule) => r.status === "active")).toBe(true);
    });

    it("filters correctly by type", async () => {
      const app = buildTestApp(boardActor, testRules);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?type=secret`)
        .expect(200);

      expect(res.body.rules).toHaveLength(2);
      expect(res.body.rules.every((r: GuardrailRule) => r.type === "secret")).toBe(true);
    });

    it("filters correctly by combined status and type", async () => {
      const app = buildTestApp(boardActor, testRules);
      const res = await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?status=active&type=secret`)
        .expect(200);

      expect(res.body.rules).toHaveLength(1);
      expect(res.body.rules[0].id).toBe("rule-1");
    });

    it("validates and rejects invalid status with 400", async () => {
      const app = buildTestApp(boardActor, testRules);
      await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?status=invalid_status`)
        .expect(400);
    });

    it("validates and rejects invalid type with 400", async () => {
      const app = buildTestApp(boardActor, testRules);
      await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?type=unknown_type`)
        .expect(400);
    });

    it("validates and rejects invalid limit with 400", async () => {
      const app = buildTestApp(boardActor, testRules);
      await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?limit=-1`)
        .expect(400);
    });

    it("validates and rejects malformed cursor with 400", async () => {
      const app = buildTestApp(boardActor, testRules);
      await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?cursor=!!!not-base64-json!!!`)
        .expect(400);
    });

    it("validates and rejects cursor pointing to nonexistent rule with 400", async () => {
      const app = buildTestApp(boardActor, testRules);
      const cursor = encodeGuardrailCursor("nonexistent-rule-id");
      await request(app)
        .get(`/api/companies/${companyId}/guardrails/rules?cursor=${cursor}`)
        .expect(400);
    });
  });

  describe("Cursor pagination (no duplicates, no skips)", () => {
    it("paginates without duplicates or missing records across all pages", async () => {
      const totalRulesCount = 23;
      const pageSize = 5;
      const testRules = generateMockGuardrailRules(totalRulesCount, "page-test");
      const app = buildTestApp(boardActor, testRules);

      const collectedRules: GuardrailRule[] = [];
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        pageCount++;
        const url: string = cursor
          ? `/api/companies/${companyId}/guardrails/rules?limit=${pageSize}&cursor=${cursor}`
          : `/api/companies/${companyId}/guardrails/rules?limit=${pageSize}`;

        const res = await request(app).get(url).expect(200);
        const { rules, nextCursor } = res.body;

        expect(rules.length).toBeLessThanOrEqual(pageSize);
        collectedRules.push(...rules);
        cursor = nextCursor;
      } while (cursor !== null);

      expect(pageCount).toBe(Math.ceil(totalRulesCount / pageSize));
      expect(collectedRules).toHaveLength(totalRulesCount);

      // Verify no duplicates
      const collectedIds = collectedRules.map((r) => r.id);
      const uniqueIds = new Set(collectedIds);
      expect(uniqueIds.size).toBe(totalRulesCount);

      // Verify no missed records and sorted ordering
      const expectedSortedIds = [...testRules]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => r.id);
      expect(collectedIds).toEqual(expectedSortedIds);
    });
  });
});
