// myrmidon(1.6.5-OWNER-DM-FILTER): the journal classification must agree with
// the filter predicate `isOwnerDecisionAudience` (part A/B).
import { describe, expect, it } from "vitest";
import { classifyOwnerDeliveryPublication } from "./classify.js";

const base = {
  effectiveResolverPolicy: "anyone",
  addresseeUserId: null,
  issueResponsibleUserId: "owner",
  issueCreatedByUserId: "creator",
};

describe("classifyOwnerDeliveryPublication", () => {
  it("human_only is an owner decision", () => {
    expect(
      classifyOwnerDeliveryPublication({ ...base, effectiveResolverPolicy: "human_only" }),
    ).toEqual({
      classification: "owner_decision",
      reason: "effective_resolver_policy_human_only",
    });
  });

  it("addressee equal to the responsible user is an owner decision", () => {
    expect(
      classifyOwnerDeliveryPublication({ ...base, addresseeUserId: "owner" }).classification,
    ).toBe("owner_decision");
  });

  it("falls back to the creator when nobody is responsible", () => {
    expect(
      classifyOwnerDeliveryPublication({
        ...base,
        issueResponsibleUserId: null,
        addresseeUserId: "creator",
      }).classification,
    ).toBe("owner_decision");
  });

  it("another user or nobody is operational", () => {
    expect(
      classifyOwnerDeliveryPublication({ ...base, addresseeUserId: "other" }),
    ).toEqual({ classification: "operational", reason: "addressee_not_issue_owner" });
    expect(classifyOwnerDeliveryPublication(base)).toEqual({
      classification: "operational",
      reason: "no_owner_addressee",
    });
  });

  it("an agent addressee is never an owner decision, even under human_only", () => {
    expect(
      classifyOwnerDeliveryPublication({
        ...base,
        effectiveResolverPolicy: "human_only",
        addresseeAgentId: "agent-1",
      }),
    ).toEqual({ classification: "operational", reason: "addressee_is_agent" });
  });
});
