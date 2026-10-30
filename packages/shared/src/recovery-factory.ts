import { z } from "zod";
import { ISSUE_RECOVERY_ACTION_KINDS } from "./constants.js";

const recoveryFactoryOwnerSchema = z.union([
  z.object({ agentId: z.string().min(1) }).strict(),
  z.object({ userId: z.string().min(1) }).strict(),
  z.object({ serviceQueue: z.string().min(1) }).strict(),
]);

export const recoveryFactoryRequestSchema = z.object({
  kind: z.enum(ISSUE_RECOVERY_ACTION_KINDS),
  sourceIssueId: z.string().min(1),
  dedupeKey: z.string().min(1),
  owner: recoveryFactoryOwnerSchema,
  slaMinutes: z.number().int().positive(),
  nextCheckAt: z.string().datetime({ offset: true }),
  runbookRef: z.string().min(1).optional(),
  evidence: z.record(z.string(), z.unknown()),
}).strict();

export type RecoveryFactoryRequest = z.infer<typeof recoveryFactoryRequestSchema>;
export type RecoveryFactoryOwner = z.infer<typeof recoveryFactoryOwnerSchema>;
export type RecoveryFactoryKind = RecoveryFactoryRequest["kind"];

/**
 * Baseline SLA in minutes for typed recovery kinds (design OPE-8312 §5.7).
 * Values at launch:
 * - ci_restart: 30
 * - github_access: 60
 * - branch_relay: 60
 * - review_participant_restore: 60
 * - workspace_myr_ws: 120
 * - devbuild: 120
 * - disk_space: 60
 * - operator_action: 120
 */
export const RECOVERY_SLA_MINUTES_BY_KIND: Readonly<Record<RecoveryFactoryKind, number>> = Object.freeze({
  ci_restart: 30,
  github_access: 60,
  branch_relay: 60,
  review_participant_restore: 60,
  workspace_myr_ws: 120,
  devbuild: 120,
  disk_space: 60,
  operator_action: 120,
  missing_disposition: 60,
  deliberate_wait_without_target: 60,
  stranded_assigned_issue: 60,
  workspace_validation: 60,
  configuration_validation: 60,
  active_run_watchdog: 60,
  issue_graph_liveness: 60,
});

export function resolveRecoverySlaMinutes(
  kind: string,
  overrides?: Partial<Record<string, number>> | null,
): number {
  if (overrides && typeof overrides[kind] === "number" && overrides[kind]! > 0) {
    return overrides[kind]!;
  }
  const defaultSla = (RECOVERY_SLA_MINUTES_BY_KIND as Record<string, number>)[kind];
  if (typeof defaultSla === "number" && defaultSla > 0) {
    return defaultSla;
  }
  return 60;
}

export interface RecoveryFactoryResult {
  outcome: "created" | "deduped";
  recoveryActionId: string;
  recoveryIssueId: string | null;
}

export interface RecoveryFactoryMetrics {
  created(kind: RecoveryFactoryRequest["kind"]): void;
  deduped(kind: RecoveryFactoryRequest["kind"]): void;
  succeeded(kind: RecoveryFactoryRequest["kind"]): void;
  age(kind: RecoveryFactoryRequest["kind"], seconds: number): void;
}

export function buildRecoveryDedupeKey(input: {
  kind: RecoveryFactoryRequest["kind"];
  scope: string;
  cause: string;
}): string {
  const canonical = JSON.stringify([input.kind, input.scope, input.cause]);
  // Deterministic cyrb128 (4×32-bit, well-mixed). No crypto dependency: this
  // package also runs in the browser, and the contract needs a stable dedupe
  // identity, not a cryptographic hash.
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < canonical.length; i += 1) {
    const k = canonical.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  return hex(h1 ^ h2 ^ h3 ^ h4) + hex(h2 ^ h1) + hex(h3 ^ h1) + hex(h4 ^ h1);
}
