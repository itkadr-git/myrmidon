import { describe, expect, it } from "vitest";
import { buildEscalationChain, type EscalationChainPolicy } from "./build-chain.js";

const policy = {
  participantRoles: ["lead", "architect", "secondary_reviewer"],
  fallbackQueue: "review-recovery",
  stepDelayMinutes: 30,
} satisfies EscalationChainPolicy;
const agent = (agentId: string) => ({ agentId });

describe("buildEscalationChain", () => {
  it("preserves role order and ends in the recovery queue", () => {
    const chain = buildEscalationChain({
      routeType: "decision",
      policy,
      projectRoles: { lead: agent("lead"), architect: agent("arch"), secondary_reviewer: agent("second") },
    });
    expect(chain.map((step) => step.recipient)).toEqual([
      agent("lead"), agent("arch"), agent("second"), { serviceQueue: "review-recovery" },
    ]);
  });

  it("skips missing roles and returns only the queue when all roles are absent", () => {
    expect(buildEscalationChain({
      routeType: "decision", policy, projectRoles: { lead: agent("lead"), secondary_reviewer: agent("second") },
    }).map((step) => step.recipient)).toEqual([
      agent("lead"), agent("second"), { serviceQueue: "review-recovery" },
    ]);
    expect(buildEscalationChain({ routeType: "decision", policy, projectRoles: {} })).toEqual([
      { recipient: { serviceQueue: "review-recovery" }, afterMinutes: 0 },
    ]);
  });

  it("deduplicates recipients and excludes user owners from code review", () => {
    const chain = buildEscalationChain({
      routeType: "code_review",
      policy,
      projectRoles: { lead: agent("same"), architect: agent("same"), secondary_reviewer: { userId: "owner" } },
    });
    expect(chain.map((step) => step.recipient)).toEqual([
      agent("same"), { serviceQueue: "review-recovery" },
    ]);
    expect(chain[0]?.recipient).not.toEqual(chain[1]?.recipient);
  });

  it("keeps a configured fallback queue terminal and assigns increasing delays", () => {
    const chain = buildEscalationChain({
      routeType: "decision",
      policy,
      projectRoles: { lead: { serviceQueue: "review-recovery" }, architect: agent("arch") },
      startAt: 10,
    });
    expect(chain).toEqual([
      { recipient: agent("arch"), afterMinutes: 10 },
      { recipient: { serviceQueue: "review-recovery" }, afterMinutes: 40 },
    ]);
  });
});
