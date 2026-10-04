// myrmidon(1.6-AUTONOMY): end-to-end deny test for the autonomy matrix.
//
// A forbidden cell stops the action at the gate: the caller gets a 403 with the
// stable error code, and no path leads from that cell to a running action. An
// allowed cell, and a caller that is not an agent, pass through.

import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { AUTONOMY_SAFE_DEFAULTS } from "@paperclipai/shared";
import {
  AUTONOMY_FORBIDDEN_CODE,
  autonomyGate,
  type AutonomyGate,
} from "./gate.js";
import { emptyAutonomyDocument, memoryAutonomyStore } from "./store.js";

const AGENT_ID = "agent-1";

function gateWith(rules: { role: string; actionClass: "merge" | "pause_wake_agents"; verdict: "allowed" | "forbidden" }[]): AutonomyGate {
  const doc = emptyAutonomyDocument();
  doc.matrix = { version: 1, rules, defaults: { ...AUTONOMY_SAFE_DEFAULTS } };
  return autonomyGate({
    store: memoryAutonomyStore(doc),
    roleOf: async (id) => (id === AGENT_ID ? "engineer" : null),
  });
}

const agentReq = { actor: { type: "agent", agentId: AGENT_ID } } as unknown as Request;
const boardReq = { actor: { type: "board", userId: "user-1" } } as unknown as Request;

describe("autonomy matrix end to end", () => {
  it("blocks a forbidden action with 403 and the stable code", async () => {
    const gate = gateWith([{ role: "engineer", actionClass: "pause_wake_agents", verdict: "forbidden" }]);
    const error = await gate.assertAllowed(agentReq, "pause_wake_agents").then(
      () => null,
      (e: unknown) => e as { status?: number; details?: { code?: string; actionClass?: string; role?: string } },
    );
    expect(error).not.toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.details?.code).toBe(AUTONOMY_FORBIDDEN_CODE);
    expect(error?.details?.actionClass).toBe("pause_wake_agents");
    expect(error?.details?.role).toBe("engineer");
  });

  it("lets an allowed action through", async () => {
    const gate = gateWith([{ role: "engineer", actionClass: "merge", verdict: "allowed" }]);
    const decision = await gate.assertAllowed(agentReq, "merge");
    expect(decision.verdict).toBe("allowed");
  });

  it("does not subject a non-agent caller to the matrix", async () => {
    const gate = gateWith([{ role: "engineer", actionClass: "merge", verdict: "forbidden" }]);
    const decision = await gate.assertAllowed(boardReq, "merge");
    expect(decision.verdict).toBe("allowed");
    expect(decision.role).toBeNull();
  });
});
