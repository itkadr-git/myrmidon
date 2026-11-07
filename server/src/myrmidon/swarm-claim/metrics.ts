// Process-local counters: bounded reasons, no task or agent identifiers.
export const SWARM_LEASE_RECOVERY_REASONS = ["lease_expired", "supervisor_rebalance"] as const;
type RecoveryReason = (typeof SWARM_LEASE_RECOVERY_REASONS)[number];

let conflicts = 0;
let recovered: Record<RecoveryReason, number> = { lease_expired: 0, supervisor_rebalance: 0 };

export const swarmClaimMetrics = {
  conflict(): void {
    conflicts += 1;
  },
  recover(reason: string, count = 1): void {
    if (reason === "lease_expired" || reason === "supervisor_rebalance") recovered[reason] += count;
  },
  read() {
    return { conflicts, recovered: { ...recovered } };
  },
  reset(): void {
    conflicts = 0;
    recovered = { lease_expired: 0, supervisor_rebalance: 0 };
  },
};
