import { METRIC_FAMILIES } from "../metrics/metrics.js";

/** K13 registration seam for B11. No collector or dashboard side effects. */
export const CAPACITY_POLICY_PANELS = [
  { id: "readiness-ratio", title: "Readiness ratio", metric: "myrmidon_readiness_ratio", unit: "ratio", groupBy: [], kind: "gauge" },
  { id: "queue-age", title: "Oldest ready queue age", metric: "myrmidon_queue_age_seconds", unit: "seconds", groupBy: [], kind: "gauge" },
  { id: "project-share", title: "Active share by project", metric: "myrmidon_project_share", unit: "ratio", groupBy: ["project"], kind: "gauge" },
  { id: "starvation", title: "Starved ready episodes", metric: "myrmidon_starvation_total", unit: "episodes", groupBy: [], kind: "counter" },
  { id: "claim-rejection", title: "Claim rejections by reason", metric: "myrmidon_claim_rejection_total", unit: "attempts", groupBy: ["reason"], kind: "counter" },
] as const;

export type CapacityPolicyPanel = (typeof CAPACITY_POLICY_PANELS)[number];

/**
 * Registration is not availability. A registered family can have no samples.
 * B11 must preserve null/absent data as unavailable, never coalesce it to zero.
 * Query scope (company/role/instance) belongs to the existing B11 source adapter.
 * Do not sum replicated company snapshots or mix unrelated source scopes.
 */
export function resolveCapacityPolicyPanels() {
  const registry: ReadonlySet<string> = new Set(METRIC_FAMILIES);
  return CAPACITY_POLICY_PANELS.map((panel) => ({
    ...panel,
    sourceStatus: registry.has(panel.metric) ? "registered" as const : "unavailable" as const,
    missingValue: null,
  }));
}

/** Delivery gate for the B11 composition owner; never fall back to local names. */
export function assertCapacityPolicySourcesRegistered(): void {
  const missing = resolveCapacityPolicyPanels().filter((panel) => panel.sourceStatus !== "registered");
  if (missing.length) {
    throw new Error(`Capacity dashboard sources are not registered: ${missing.map((panel) => panel.metric).join(", ")}`);
  }
}
