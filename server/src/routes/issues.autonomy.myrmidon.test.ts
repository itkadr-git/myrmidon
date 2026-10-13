// myrmidon(1.6.3-AUTONOMY-DELETE): enforcement of the `delete` action class
// on the agent-accessible DELETE routes.
//
// The gate is the unit under test: the six DELETE handlers call
// `dbAutonomyGate(db).assertAllowed(req, "delete")` after their access checks
// and before any destructive work. This suite proves the gate's contract for
// that call site:
//   1. an agent caller whose role forbids `delete` gets 403 with the stable
//      `autonomy_forbidden` code, and the handler body never runs — no data
//      is deleted on refusal;
//   2. an agent caller whose role allows `delete` passes the gate;
//   3. a board caller is not subject to the matrix at all.
//
// No database: the gate runs over memoryAutonomyStore with a fixed role, the
// same way routes.myrmidon.test.ts exercises it.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_SAFE_DEFAULTS } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { autonomyGate, AUTONOMY_FORBIDDEN_CODE } from "../myrmidon/autonomy/gate.js";
import { memoryAutonomyStore } from "../myrmidon/autonomy/store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
  companyIds: [COMPANY_ID],
};

type DeleteVerdict = "allowed" | "forbidden";

/**
 * A tiny express app standing in for each of the six gated DELETE handlers:
 * the gate runs exactly where the route calls it — after access checks, before
 * the destructive body — and `ran` records whether any deletion happened.
 */
function deleteGatedApp(actor: unknown, verdict: DeleteVerdict, role = "engineer") {
  const store = memoryAutonomyStore({
    version: 1,
    matrix: {
      version: 2,
      rules: [{ role, actionClass: "delete", verdict }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    },
    regulations: [],
  });
  const gate = autonomyGate({ store, roleOf: async () => role });
  const ran = vi.fn();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.delete("/api/issues/:id", async (req, res, next) => {
    try {
      await gate.assertAllowed(req, "delete");
      ran();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  server.use(errorHandler);
  return { server, ran };
}

describe("myrmidon(1.6.3-AUTONOMY-DELETE) gate on DELETE routes", () => {
  it("refuses an agent whose role forbids delete: 403 autonomy_forbidden, handler never runs", async () => {
    const { server, ran } = deleteGatedApp(agentActor, "forbidden");
    const res = await request(server).delete(`/api/issues/${AGENT_ID}`).expect(403);
    expect(res.body.code).toBe(AUTONOMY_FORBIDDEN_CODE);
    expect(res.body.details?.actionClass).toBe("delete");
    expect(res.body.details?.role).toBe("engineer");
    // No data is deleted on refusal: the handler body never executed.
    expect(ran).not.toHaveBeenCalled();
  });

  it("lets an agent whose role allows delete through the gate", async () => {
    const { server, ran } = deleteGatedApp(agentActor, "allowed");
    await request(server).delete(`/api/issues/${AGENT_ID}`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("lets a board caller through even when the role's delete cell is forbidden", async () => {
    const { server, ran } = deleteGatedApp(boardActor, "forbidden");
    await request(server).delete(`/api/issues/${AGENT_ID}`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("reports the delete verdict for approval_required without throwing", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "delete", verdict: "approval_required" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const decision = await gate.decide({ actor: agentActor } as never, "delete");
    expect(decision.verdict).toBe("approval_required");
    expect(decision.role).toBe("engineer");
    expect(decision.actionClass).toBe("delete");
  });

  it("applies the matrix per role: a role without a forbidding rule is not denied", async () => {
    const { server, ran } = deleteGatedApp(agentActor, "allowed", "viewer");
    await request(server).delete(`/api/issues/${AGENT_ID}`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
