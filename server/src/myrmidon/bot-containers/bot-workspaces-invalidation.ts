// myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE): process-local invalidation registry
// for the per-bot desired-state cache of `botWorkspacesService`.
//
// The cache (300 s window) is contract-safe for a slowly moving board, but two
// board mutations make a cached answer dangerous: a closed task that is
// reopened must return to `protectKeys` at once (otherwise botd archives and
// deletes the task's directory out from under the agent working on it), and a
// reassignment must move the key between the old and the new bot's cache
// entries. The issue route cannot reach the service instance directly (both
// are built in app.ts), so the service registers its drop callback here and
// the route publishes the event.
//
// Process-local: a single board process serves both sides. This must never
// become a cross-instance channel; multi-instance deployments would need a
// shared invalidation bus instead.

export interface DesiredStateInvalidation {
  companyId: string;
  previousAssigneeAgentId?: string | null;
  nextAssigneeAgentId?: string | null;
}

type DropFn = (input: { companyId: string; agentId: string }) => void;

const droppers = new Set<DropFn>();

/** Called by the workspaces service at construction. Returns the unsubscribe. */
export function registerDesiredStateDropper(drop: DropFn): () => void {
  droppers.add(drop);
  return () => {
    droppers.delete(drop);
  };
}

/**
 * Drop every cached desired-state entry that could still hold the task under
 * its pre-mutation state: the previous bot's entry (the task may sit in its
 * closedKeys) and the next bot's entry (the task must enter its protectKeys).
 */
export function invalidateDesiredStateForIssueChange(input: DesiredStateInvalidation): void {
  const agentIds = new Set<string>();
  if (input.previousAssigneeAgentId) agentIds.add(input.previousAssigneeAgentId);
  if (input.nextAssigneeAgentId) agentIds.add(input.nextAssigneeAgentId);
  for (const drop of droppers) {
    for (const agentId of agentIds) {
      drop({ companyId: input.companyId, agentId });
    }
  }
}
