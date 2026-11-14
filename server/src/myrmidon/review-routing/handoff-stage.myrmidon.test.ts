import { describe, expect, it } from "vitest";
import { buildHandoffReviewPolicy, selectHandoffReviewerIds } from "./handoff-stage.js";

const reviewers = [
  { id: "r2", name: "adm-dev-review-2", metadata: { telegramGroup: "adm" } },
  { id: "r1", name: "adm-dev-review-1", metadata: { telegramGroup: "adm" } },
  { id: "b1", name: "bbq-dev-review-1", metadata: { telegramGroup: "bbq" } },
  { id: "r3", name: "adm-dev-review-3", metadata: { telegramGroup: "adm" }, invokable: false },
  { id: "r4", name: "adm-dev-review-4", metadata: { telegramGroup: "adm" }, swarmQueueEligible: false },
];

describe("selectHandoffReviewerIds (OPE-13099)", () => {
  it("takes the invokable queue reviewers of the group only, sorted", () => {
    expect(selectHandoffReviewerIds({ reviewers, groupKey: "adm", excludedAgentIds: [] })).toEqual(["r1", "r2"]);
  });
  it("skips excluded agents and returns nothing when the group is empty", () => {
    expect(selectHandoffReviewerIds({ reviewers, groupKey: "adm", excludedAgentIds: ["r1"] })).toEqual(["r2"]);
    expect(selectHandoffReviewerIds({ reviewers, groupKey: "qa", excludedAgentIds: [] })).toEqual([]);
  });
});

describe("buildHandoffReviewPolicy (OPE-13099)", () => {
  it("builds a policy from nothing", () => {
    expect(buildHandoffReviewPolicy(null, ["r1"])).toEqual({
      mode: "normal",
      stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: "r1" }] }],
    });
  });
  it("keeps the previous policy fields and stages", () => {
    const previous = { mode: "normal", monitor: { nextCheckAt: "x" }, stages: [{ type: "approval", participants: [] }] };
    const next = buildHandoffReviewPolicy(previous, ["r1", "r2"]) as any;
    expect(next.monitor).toEqual(previous.monitor);
    expect(next.stages.map((stage: any) => stage.type)).toEqual(["review", "approval"]);
    expect(next.stages[0].participants).toHaveLength(2);
  });
  it("adds nothing without reviewers or when a review stage exists", () => {
    expect(buildHandoffReviewPolicy(null, [])).toBeNull();
    expect(buildHandoffReviewPolicy({ mode: "normal", stages: [{ type: "review" }] }, ["r1"])).toBeNull();
  });
});
