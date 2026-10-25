import type { BlockerRootFanout } from "@myrmidon/shared";

export const DEFAULT_ROOT_FANOUT_LIMIT = 10;

export interface RootFanoutAlert {
  rootIssueId: string;
  dependentCount: number;
  limit: number;
  severity: "warning";
}

/** Return alerts only for roots whose dependent count exceeds the configured limit. */
export function evaluateRootFanoutAlerts(
  roots: BlockerRootFanout[],
  limit: number = DEFAULT_ROOT_FANOUT_LIMIT,
): RootFanoutAlert[] {
  return roots
    .filter(({ dependentCount }) => dependentCount > limit)
    .map(({ rootIssueId, dependentCount }) => ({
      rootIssueId,
      dependentCount,
      limit,
      severity: "warning",
    }));
}
