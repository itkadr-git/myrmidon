export interface StatusStrip {
  colony: { running: number; idle: number; paused: number; error: number };
  runs: { running: number; queued: number; failedToday: number };
  costs: { monthSpendCents: number; budgetCents: number; unpricedEvents: number; forecastCents: number | null };
  waiting: { approvals: number; decisions: number; interactions: number };
}
