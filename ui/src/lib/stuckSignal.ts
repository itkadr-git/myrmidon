import type { AttentionItem, Issue, AgentListItem } from "@paperclipai/shared";

export interface StuckSignalCounts {
  attentionIssuesWithoutMotion: number;
  idleEngineers: number;
}

/** Counts existing signals and open owned work without triggering any updates. */
export function getStuckSignalCounts(
  items: AttentionItem[],
  issues: Issue[],
  agents: AgentListItem[],
): StuckSignalCounts {
  const issueIds = new Set<string>();
  for (const item of items) {
    for (const subject of [item.subject, item.relatedIssue]) {
      if (subject?.kind === "issue" && subject.id) issueIds.add(subject.id);
    }
  }
  const openByAgent = new Set(
    issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled" && issue.assigneeAgentId)
      .map((issue) => issue.assigneeAgentId!),
  );
  const idleEngineers = agents.filter((agent) =>
    /engineer/i.test(`${agent.role} ${agent.title ?? ""}`)
      && agent.status === "active"
      && !openByAgent.has(agent.id),
  ).length;
  return { attentionIssuesWithoutMotion: issueIds.size, idleEngineers };
}