import { describe, expect, it } from "vitest";
import { getStuckSignalCounts } from "./stuckSignal";
import type { AgentListItem, AttentionItem, Issue } from "@myrmidonai/shared";

describe("getStuckSignalCounts", () => {
  it("counts distinct attention-linked issues and active engineers with no open assignment", () => {
    const subject = (id: string) => ({ kind: "issue" as const, id, identifier: id, title: id });
    const items = [
      { subject: subject("I-1"), relatedIssue: subject("I-2") },
      { subject: subject("I-1"), relatedIssue: null },
    ] as AttentionItem[];
    const issues = [{ status: "in_progress", assigneeAgentId: "busy" }] as Issue[];
    const agents = [
      { id: "busy", role: "engineer", title: null, status: "active" },
      { id: "idle", role: "engineer", title: null, status: "active" },
      { id: "off", role: "engineer", title: null, status: "paused" },
      { id: "lead", role: "lead", title: "Engineer", status: "active" },
      { id: "designer", role: "designer", title: "Engineering Designer", status: "active" },
      { id: "custom", role: "engineering", title: "Engineer", status: "active" },
    ] as AgentListItem[];
    expect(getStuckSignalCounts(items, issues, agents)).toEqual({
      attentionIssuesWithoutMotion: 2,
      idleEngineers: 1,
    });
  });
});