import { describe, expect, it } from "vitest";
import { INTERACTION_ROUTE_TYPES, interactionRoutingInputSchema } from "./interaction-routing.js";

const validInput = {
  routeType: "decision",
  recipient: { agentId: "agent-1" },
  timeoutAt: "2026-01-01T00:00:00.000Z",
  escalationChain: [{ recipient: { userId: "user-1" }, afterMinutes: 30 }],
  dedupeKey: "decision:1",
};

describe("interactionRoutingInputSchema", () => {
  it("accepts every route type", () => {
    for (const routeType of INTERACTION_ROUTE_TYPES) {
      expect(interactionRoutingInputSchema.safeParse({ ...validInput, routeType }).success).toBe(true);
    }
  });

  it.each([
    ["missing recipient", { recipient: undefined }],
    ["two recipient kinds", { recipient: { agentId: "agent-1", userId: "user-1" } }],
    ["missing timeout", { timeoutAt: undefined }],
    ["empty escalation chain", { escalationChain: [] }],
  ])("rejects %s", (_label, patch) => {
    expect(interactionRoutingInputSchema.safeParse({ ...validInput, ...patch }).success).toBe(false);
  });
});
