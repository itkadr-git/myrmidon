import type { BlockerRootFanout, IssueBlockerAttention, IssueRelationIssueSummary } from "@myrmidon/shared";

export type WaitingBlockerStatus = "done" | "running" | "queued";

export interface WaitingBlockerStep {
  blocker: IssueRelationIssueSummary;
  status: WaitingBlockerStatus;
}

export function classifyWaitingBlocker(
  blocker: IssueRelationIssueSummary,
  liveIssueIds: ReadonlySet<string>,
): WaitingBlockerStatus {
  if (blocker.status === "done" || blocker.status === "cancelled") return "done";
  if (liveIssueIds.has(blocker.id)) return "running";
  return "queued";
}

const WAITING_BLOCKER_RANK: Record<WaitingBlockerStatus, number> = {
  done: 0,
  running: 1,
  queued: 2,
};

/**
 * Orders the explicit blocker queue the same way in every task surface.
 *
 * The blocker payload does not carry an explicit sequence. Status gives the
 * operational order (completed work, current work, queued work), while the
 * identifier is the stable tie-break used by plan-generated task chains.
 */
export function orderWaitingBlockers(
  blockers: IssueRelationIssueSummary[],
  liveIssueIds: ReadonlySet<string>,
): WaitingBlockerStep[] {
  return blockers
    .map((blocker) => ({ blocker, status: classifyWaitingBlocker(blocker, liveIssueIds) }))
    .sort((a, b) => {
      const rank = WAITING_BLOCKER_RANK[a.status] - WAITING_BLOCKER_RANK[b.status];
      if (rank !== 0) return rank;
      const aKey = a.blocker.identifier ?? a.blocker.id;
      const bKey = b.blocker.identifier ?? b.blocker.id;
      return aKey.localeCompare(bKey, undefined, { numeric: true });
    });
}

export function isAssignedBacklogBlocker(blocker: IssueRelationIssueSummary): boolean {
  return blocker.status === "backlog" && Boolean(blocker.assigneeAgentId);
}

export function hasAssignedBacklogBlocker(
  blockers: IssueRelationIssueSummary[] | undefined | null,
): boolean {
  if (!blockers || blockers.length === 0) return false;
  return blockers.some((blocker) => {
    if (isAssignedBacklogBlocker(blocker)) return true;
    if (blocker.terminalBlockers?.some(isAssignedBacklogBlocker)) return true;
    return false;
  });
}

export interface RootFanoutInfo {
  rootId?: string | null;
  rootIdentifier: string;
  dependentCount: number;
}

export type RootFanoutInput =
  | BlockerRootFanout
  | {
      rootIssueId?: string | null;
      rootIdentifier?: string | null;
      dependentCount?: number | null;
      fanout?: number | null;
      id?: string | null;
      identifier?: string | null;
    }
  | number
  | null
  | undefined;

export function extractRootFanout(options: {
  rootFanout?: RootFanoutInput;
  rootFanouts?: BlockerRootFanout[] | null;
  blockerAttention?: IssueBlockerAttention | null;
  blockers?: IssueRelationIssueSummary[] | null;
  terminalBlockers?: IssueRelationIssueSummary[] | null;
  issueId?: string | null;
}): RootFanoutInfo | null {
  const { rootFanout, rootFanouts, blockerAttention, blockers, terminalBlockers, issueId } = options;

  if (typeof rootFanout === "number") {
    if (rootFanout > 1) {
      const fallbackIdentifier =
        blockerAttention?.terminalBlocker?.identifier ??
        terminalBlockers?.[0]?.identifier ??
        blockers?.[0]?.identifier ??
        null;
      const fallbackId =
        blockerAttention?.terminalBlocker?.id ??
        terminalBlockers?.[0]?.id ??
        blockers?.[0]?.id ??
        null;
      if (fallbackIdentifier) {
        return {
          rootId: fallbackId,
          rootIdentifier: fallbackIdentifier,
          dependentCount: rootFanout,
        };
      }
    }
  } else if (rootFanout && typeof rootFanout === "object") {
    const rf = rootFanout as {
      rootIssueId?: string | null;
      rootIdentifier?: string | null;
      dependentCount?: number | null;
      fanout?: number | null;
      id?: string | null;
      identifier?: string | null;
    };
    const count = rf.dependentCount ?? rf.fanout ?? 0;
    const identifier = rf.rootIdentifier ?? rf.identifier ?? null;
    const id = rf.rootIssueId ?? rf.id ?? null;
    if (count > 1 && identifier) {
      return {
        rootId: id,
        rootIdentifier: identifier,
        dependentCount: count,
      };
    }
  }

  if (Array.isArray(rootFanouts) && rootFanouts.length > 0) {
    const candidateRootIds = new Set<string>();
    const candidateRootIdentifiers = new Set<string>();

    if (blockerAttention?.terminalBlocker?.id) {
      candidateRootIds.add(blockerAttention.terminalBlocker.id);
    }
    if (blockerAttention?.terminalBlocker?.identifier) {
      candidateRootIdentifiers.add(blockerAttention.terminalBlocker.identifier);
    }
    for (const t of terminalBlockers ?? []) {
      if (t.id) candidateRootIds.add(t.id);
      if (t.identifier) candidateRootIdentifiers.add(t.identifier);
    }
    for (const b of blockers ?? []) {
      if (b.id) candidateRootIds.add(b.id);
      if (b.identifier) candidateRootIdentifiers.add(b.identifier);
      for (const tb of b.terminalBlockers ?? []) {
        if (tb.id) candidateRootIds.add(tb.id);
        if (tb.identifier) candidateRootIdentifiers.add(tb.identifier);
      }
    }

    let matched: BlockerRootFanout | null = null;
    for (const item of rootFanouts) {
      if (!item || item.dependentCount <= 1) continue;
      if (
        candidateRootIds.has(item.rootIssueId) ||
        candidateRootIdentifiers.has(item.rootIdentifier)
      ) {
        matched = item;
        break;
      }
    }

    if (!matched && issueId) {
      for (const item of rootFanouts) {
        if (!item || item.dependentCount <= 1) continue;
        if (Array.isArray(item.dependents) && item.dependents.includes(issueId)) {
          matched = item;
          break;
        }
      }
    }

    if (!matched && candidateRootIds.size > 0) {
      for (const item of rootFanouts) {
        if (!item || item.dependentCount <= 1) continue;
        if (
          Array.isArray(item.dependents) &&
          item.dependents.some((d) => candidateRootIds.has(d))
        ) {
          matched = item;
          break;
        }
      }
    }

    if (matched && matched.rootIdentifier) {
      return {
        rootId: matched.rootIssueId,
        rootIdentifier: matched.rootIdentifier,
        dependentCount: matched.dependentCount,
      };
    }
  }

  if (blockerAttention) {
    const ba = blockerAttention as {
      sampleBlockerIdentifier?: string | null;
      terminalBlockerIssueId?: string | null;
      terminalBlocker?: { id?: string | null; identifier?: string | null; dependentCount?: number | null; fanout?: number | null } | null;
      dependentCount?: number | null;
      fanout?: number | null;
      rootFanout?: number | null;
    };
    const attentionCount =
      ba.terminalBlocker?.dependentCount ??
      ba.terminalBlocker?.fanout ??
      ba.dependentCount ??
      ba.fanout ??
      ba.rootFanout ??
      0;
    const attentionIdentifier =
      ba.terminalBlocker?.identifier ??
      ba.sampleBlockerIdentifier ??
      null;
    const attentionId =
      ba.terminalBlocker?.id ??
      ba.terminalBlockerIssueId ??
      null;
    if (attentionCount > 1 && attentionIdentifier) {
      return {
        rootId: attentionId,
        rootIdentifier: attentionIdentifier,
        dependentCount: attentionCount,
      };
    }
  }

  if (terminalBlockers && terminalBlockers.length > 0) {
    for (const t of terminalBlockers) {
      const item = t as { id?: string | null; identifier?: string | null; dependentCount?: number | null; fanout?: number | null };
      const count = item.dependentCount ?? item.fanout ?? 0;
      if (count > 1 && item.identifier) {
        return {
          rootId: item.id,
          rootIdentifier: item.identifier,
          dependentCount: count,
        };
      }
    }
  }

  if (blockers && blockers.length > 0) {
    for (const b of blockers) {
      const bItem = b as {
        id?: string | null;
        identifier?: string | null;
        dependentCount?: number | null;
        fanout?: number | null;
        terminalBlockers?: Array<{ id?: string | null; identifier?: string | null; dependentCount?: number | null; fanout?: number | null }> | null;
      };
      if (bItem.terminalBlockers && bItem.terminalBlockers.length > 0) {
        for (const t of bItem.terminalBlockers) {
          const count = t.dependentCount ?? t.fanout ?? 0;
          if (count > 1 && t.identifier) {
            return {
              rootId: t.id,
              rootIdentifier: t.identifier,
              dependentCount: count,
            };
          }
        }
      }
      const count = bItem.dependentCount ?? bItem.fanout ?? 0;
      if (count > 1 && bItem.identifier) {
        return {
          rootId: bItem.id,
          rootIdentifier: bItem.identifier,
          dependentCount: count,
        };
      }
    }
  }

  return null;
}
