export interface FailedBeforeModelMetricsRegistry {
  recordFailure(agentId: string): void;
  get(agentId: string): number;
  getAll(): Record<string, number>;
  reset(): void;
}

export function createFailedBeforeModelMetricsRegistry(): FailedBeforeModelMetricsRegistry {
  const counts = new Map<string, number>();
  return {
    recordFailure(agentId: string): void {
      if (!agentId) return;
      counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    },
    get(agentId: string): number {
      return counts.get(agentId) ?? 0;
    },
    getAll(): Record<string, number> {
      return Object.fromEntries(counts.entries());
    },
    reset(): void {
      counts.clear();
    },
  };
}

export const failedBeforeModelMetrics = createFailedBeforeModelMetricsRegistry();
