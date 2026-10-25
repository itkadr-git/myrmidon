import type { BlockerRootFanout } from "@myrmidon/shared/blocker-graph";
import { isBlockerOpen } from "../../myrmidon/blocker-resolved.js";

export interface BlockerEdge {
  blockedId: string;
  blockerId: string;
  blockerStatus: string;
}

/** Collapse open blocker chains into terminal roots and count held issues. */
export function computeRootFanout(edges: BlockerEdge[]): BlockerRootFanout[] {
  const openEdges = edges.filter((edge) => isBlockerOpen(edge.blockerStatus));
  const blockersByIssue = new Map<string, string[]>();
  const statusById = new Map<string, string>();
  for (const { blockedId, blockerId, blockerStatus } of openEdges) {
    const blockers = blockersByIssue.get(blockedId) ?? [];
    if (!blockers.includes(blockerId)) blockers.push(blockerId);
    blockersByIssue.set(blockedId, blockers);
    statusById.set(blockerId, blockerStatus);
  }

  const fanout = new Map<string, Set<string>>();
  const cyclic = new Set<string>();
  const resolve = (issueId: string, dependentId: string, path: Set<string>): void => {
    if (path.has(issueId)) {
      cyclic.add(issueId);
      for (const id of path) cyclic.add(id);
      return;
    }
    const blockers = blockersByIssue.get(issueId) ?? [];
    if (blockers.length === 0) {
      if (issueId !== dependentId) {
        const dependents = fanout.get(issueId) ?? new Set<string>();
        dependents.add(dependentId);
        fanout.set(issueId, dependents);
      }
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(issueId);
    for (const blocker of blockers) resolve(blocker, dependentId, nextPath);
  };

  for (const blockedId of blockersByIssue.keys()) resolve(blockedId, blockedId, new Set());

  return [...fanout.entries()].map(([rootIssueId, dependents]) => ({
    rootIssueId,
    rootIdentifier: rootIssueId,
    rootStatus: statusById.get(rootIssueId) ?? "unknown",
    dependentCount: dependents.size,
    dependents: [...dependents].sort(),
    oldestBlockedAt: null,
    hasMissingFields: true,
  })).concat([...cyclic].sort().map((issueId) => ({
    rootIssueId: issueId,
    rootIdentifier: issueId,
    rootStatus: statusById.get(issueId) ?? "unknown",
    dependentCount: 0,
    dependents: [],
    oldestBlockedAt: null,
    hasMissingFields: true,
  })));
}
