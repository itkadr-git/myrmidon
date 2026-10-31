// server/src/myrmidon/guardrails/regex-validator.myrmidon.test.ts
//
// myrmidon(1.7 GUARDRAILS, OPE-10181): tests for regex rule validator & ReDoS safety routes.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonGuardrailsRoutes } from "./routes.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";

function boardActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

function agentActor(companyId: string) {
  return {
    type: "agent",
    source: "agent_key",
    agentId: "10000000-0000-4000-8000-0000000000b1",
    companyId,
    keyId: "key-a",
  };
}

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", myrmidonGuardrailsRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

describe("guardrail regex validator routes", () => {
  const companyEndpoint = `/api/myrmidon/companies/${COMPANY_ID}/guardrails/validate-regex`;
  const globalEndpoint = "/api/myrmidon/guardrails/validate-regex";

  describe("POST /api/myrmidon/companies/:companyId/guardrails/validate-regex", () => {
    it("validates a safe regex pattern and tests sample inputs", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({
          pattern: "api_key_[a-z0-9]{16}",
          flags: "i",
          testInputs: ["api_key_abcdef1234567890", "regular text"],
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.pattern).toBe("api_key_[a-z0-9]{16}");
      expect(res.body.flags).toBe("i");
      expect(res.body.redosRisk).toBe(false);
      expect(res.body.complexity).toBe("low");
      expect(res.body.sampleMatches).toEqual([
        { input: "api_key_abcdef1234567890", matched: true },
        { input: "regular text", matched: false },
      ]);
    });

    it("detects ReDoS vulnerability (nested quantifiers)", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({
          pattern: "(a+)+$",
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.redosRisk).toBe(true);
      expect(res.body.riskReason).toContain("Nested quantifiers");
      expect(res.body.complexity).toBe("vulnerable");
    });

    it("detects ReDoS vulnerability (overlapping alternatives)", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({
          pattern: "(foo|foobar)+",
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.redosRisk).toBe(true);
      expect(res.body.riskReason).toContain("Overlapping alternatives");
    });

    it("returns valid: false when regex syntax is invalid", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({
          pattern: "[a-z",
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.redosRisk).toBe(false);
    });

    it("returns 400 for empty or missing pattern", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid flags", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({
          pattern: "test",
          flags: "invalid_flags",
        });

      expect(res.status).toBe(400);
    });

    it("refuses access for agents (board only)", async () => {
      const app = createApp(agentActor(COMPANY_ID));
      const res = await request(app)
        .post(companyEndpoint)
        .send({ pattern: "test" });

      expect(res.status).toBe(403);
    });

    it("refuses access for unauthenticated callers", async () => {
      const app = createApp({ type: "none" });
      const res = await request(app)
        .post(companyEndpoint)
        .send({ pattern: "test" });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/myrmidon/guardrails/validate-regex (global route)", () => {
    it("validates regex via the board-wide route", async () => {
      const app = createApp(boardActor(COMPANY_ID));
      const res = await request(app)
        .post(globalEndpoint)
        .send({
          pattern: "\\b\\d{4}-\\d{4}-\\d{4}-\\d{4}\\b",
          testInputs: ["Card: 1234-5678-9012-3456"],
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.redosRisk).toBe(false);
      expect(res.body.sampleMatches?.[0]?.matched).toBe(true);
    });
  });
});
