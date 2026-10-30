import assert from "node:assert/strict";
import test from "node:test";
import { classifyLegacyBlocked } from "./classify.ts";

const cases = [
  {
    name: "open issue explicitly blocks this work",
    facts: { links: [{ type: "issue", relation: "blocks", status: "in_progress", label: "OPE-10" }] },
    expected: "dependency",
  },
  {
    name: "linked issue explicitly owns recovery work",
    facts: { links: [{ type: "issue", relation: "recovery", status: "todo", label: "OPE-11" }] },
    expected: "recovery",
  },
  {
    name: "pending interaction requires a human decision",
    facts: { links: [{ type: "interaction", status: "pending", label: "owner decision" }] },
    expected: "human_decision",
  },
  {
    name: "pending external reference is waiting",
    facts: { links: [{ type: "external", status: "pending", label: "vendor response" }] },
    expected: "external_wait",
  },
  {
    name: "explicit resource link identifies a resource blocker",
    facts: { links: [{ type: "resource", status: "unavailable", label: "GitHub access" }] },
    expected: "resource",
  },
  {
    name: "explicitly cancelled task is terminal",
    facts: { taskStatus: "cancelled" },
    expected: "terminal",
  },
  {
    name: "open PR with pending checks is external wait",
    facts: { pullRequests: [{ state: "open", checksState: "pending", reviewState: "unknown" }] },
    expected: "external_wait",
  },
  {
    name: "open PR awaiting review is external wait",
    facts: { pullRequests: [{ state: "open", checksState: "passed", reviewState: "pending" }] },
    expected: "external_wait",
  },
  {
    name: "comment explicitly says blocked by an issue",
    facts: { latestComments: ["Progress is blocked by OPE-12 until its change lands."] },
    expected: "dependency",
  },
  {
    name: "comment explicitly requests owner decision",
    facts: { latestComments: ["Awaiting owner decision before proceeding."] },
    expected: "human_decision",
  },
  {
    name: "comment explicitly records missing permission",
    facts: { latestComments: ["Unable to proceed: permission denied for the required repository."] },
    expected: "resource",
  },
  {
    name: "comment explicitly records a duplicate outcome",
    facts: { latestComments: ["This request is a duplicate; no further work is needed."] },
    expected: "terminal",
  },
  {
    name: "no relevant facts remains unknown",
    facts: {},
    expected: "unknown",
  },
  {
    name: "resolved blocker alone does not establish a current class",
    facts: { links: [{ type: "issue", relation: "blocks", status: "done", label: "OPE-13" }] },
    expected: "unknown",
  },
  {
    name: "conflicting explicit facts remain unknown",
    facts: {
      links: [
        { type: "issue", relation: "blocks", status: "in_progress", label: "OPE-14" },
        { type: "interaction", status: "pending", label: "decision" },
      ],
    },
    expected: "unknown",
  },
  {
    name: "closed PR without merge does not imply terminal",
    facts: { pullRequests: [{ state: "closed", checksState: "unknown", reviewState: "unknown" }] },
    expected: "unknown",
  },
  {
    name: "comment mentioning resolved dependency is not current evidence",
    facts: { latestComments: ["The dependency is resolved; we are not waiting for CI or a human decision."] },
    expected: "unknown",
  },
  {
    name: "comment containing conflicting present-tense blockers is unknown",
    facts: { latestComments: ["Waiting for owner decision and blocked by OPE-15."] },
    expected: "unknown",
  },
];

test("classifyLegacyBlocked has conservative table-driven coverage", async (t) => {
  for (const { name, facts, expected } of cases) {
    await t.test(name, () => {
      const result = classifyLegacyBlocked(facts);
      assert.equal(result.class, expected);
      assert.ok(Array.isArray(result.evidence));
      if (result.class !== "unknown") {
        assert.ok(result.evidence.some((item) => item.trim().length > 0));
      }
    });
  }
});
