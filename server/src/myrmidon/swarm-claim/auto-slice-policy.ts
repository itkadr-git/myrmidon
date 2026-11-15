export interface QueueShortage {
  companyId: string;
  projectId: string;
  ready: number;
  free: number;
}

/** Count only free engineers belonging to each project and its own ready queue. */
export function projectQueueShortages(
  companyId: string,
  projects: readonly { projectId: string; memberIds: ReadonlySet<string> }[],
  freeAgentIds: readonly string[],
  readyTasks: readonly { projectId: string | null }[],
): QueueShortage[] {
  return projects.map(({ projectId, memberIds }) => ({
    companyId,
    projectId,
    ready: readyTasks.filter((task) => task.projectId === projectId).length,
    free: new Set(freeAgentIds.filter((agentId) => memberIds.has(agentId))).size,
  }));
}

/** Track uninterrupted shortages separately for each company and project. */
export function createAutoSlicePolicy(delayMs = 10 * 60_000) {
  const since = new Map<string, number>();
  return {
    observe(input: QueueShortage, nowMs: number): number {
      const key = JSON.stringify([input.companyId, input.projectId]);
      const shortage = Math.max(0, input.free - input.ready);
      if (shortage === 0) {
        since.delete(key);
        return 0;
      }
      const start = since.get(key);
      if (start === undefined || nowMs < start) {
        since.set(key, nowMs);
        return 0;
      }
      return nowMs - start >= delayMs ? shortage : 0;
    },
  };
}
