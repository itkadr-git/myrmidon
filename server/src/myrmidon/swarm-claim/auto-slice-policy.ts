export interface ReleaseEpic {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

/** Select open, explicitly marked epics belonging to the configured release. */
export function releaseEpicCandidates<T extends ReleaseEpic>(rows: readonly T[], release: string | null): T[] {
  if (!release) return [];
  const version = release.replace(/^v/i, "").replace(/-rc[.\-]?\d+.*$/i, "");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`(?:^|[^0-9.])${escaped}(?![0-9.])`, "i");
  return rows.filter((row) => !["done", "cancelled"].includes(row.status)
    && /(?:epic|эпик)/i.test(row.title) && marker.test(row.title));
}

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

export async function runAutoSlicePass(
  policy: ReturnType<typeof createAutoSlicePolicy>,
  shortages: readonly QueueShortage[],
  nowMs: number,
  ports: { createIfAbsent(input: { companyId: string; projectId: string; needed: number }): Promise<boolean> },
): Promise<void> {
  for (const shortage of shortages) {
    const needed = policy.observe(shortage, nowMs);
    if (needed > 0) {
      await ports.createIfAbsent({ companyId: shortage.companyId, projectId: shortage.projectId, needed });
    }
  }
}

/**
 * Statuses of an existing slicing task that stop the board from creating the next one.
 * `blocked` and `in_review` are deliberately absent: a lead that has cut its tasks parks
 * the slicing task behind them as blockers, and that must not freeze the queue refill
 * for hours. Duplicates of a task that is still being created are caught by `todo`.
 */
export const AUTO_SLICE_DEDUPE_STATUSES = ["backlog", "todo", "in_progress"] as const;

export function autoSliceBlocksNext(status: string): boolean {
  return (AUTO_SLICE_DEDUPE_STATUSES as readonly string[]).includes(status);
}

export const AUTO_SLICE_TITLE = "[AUTO-SLICE] Пополнить очередь инженеров";
