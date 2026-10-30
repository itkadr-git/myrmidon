import { describe, expect, it } from "vitest";
import { buildSeniorChain, type EscalationAgentRow } from "../services/review-escalation-chain.ts";

const row = (id: string, name: string, reportsTo: string | null, status = "idle"): EscalationAgentRow => ({
  id, name, status, reportsTo, pausedAt: null,
});
const adm = row("adm", "adm", null);
const mgr = row("mgr", "mgr", "adm");
const reviewer = row("rev", "rev", "mgr");
const executor = row("exec", "exec", "mgr");
const lead = row("lead", "lead", "adm");
const all = [adm, mgr, reviewer, executor, lead];

describe("buildSeniorChain (OPE-9031)", () => {
  it("starts with the reviewer's manager, continues upward, then lead and adm", () => {
    expect(buildSeniorChain({ agents: all, reviewerAgentId: "rev", projectLeadAgentId: "lead", returnAssigneeAgentId: "exec" }))
      .toEqual(["mgr", "adm", "lead"]);
  });
  it("without a manager goes to the project lead, then adm", () => {
    const orphan = row("rev", "rev", null);
    expect(buildSeniorChain({ agents: [adm, orphan, lead], reviewerAgentId: "rev", projectLeadAgentId: "lead", returnAssigneeAgentId: null }))
      .toEqual(["lead", "adm"]);
  });
  it("skips paused and terminated agents, the reviewer and the executor", () => {
    const paused = { ...mgr, status: "paused" };
    const gone = { ...lead, status: "terminated" };
    expect(buildSeniorChain({ agents: [adm, paused, reviewer, executor, gone], reviewerAgentId: "rev", projectLeadAgentId: "lead", returnAssigneeAgentId: "exec" }))
      .toEqual(["adm"]);
    expect(buildSeniorChain({ agents: [adm, reviewer], reviewerAgentId: "adm", projectLeadAgentId: null, returnAssigneeAgentId: "rev" }))
      .toEqual([]);
  });
  it("returns nobody (-> recovery, never a human) when no agent qualifies", () => {
    expect(buildSeniorChain({ agents: [reviewer], reviewerAgentId: "rev", projectLeadAgentId: null, returnAssigneeAgentId: null })).toEqual([]);
  });
  it("survives a reports_to cycle", () => {
    const a = row("a", "a", "b");
    const b = row("b", "b", "a");
    expect(buildSeniorChain({ agents: [a, b], reviewerAgentId: "a", projectLeadAgentId: null, returnAssigneeAgentId: null })).toEqual(["b"]);
  });
});
