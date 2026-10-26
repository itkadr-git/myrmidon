import { buildRecoveryDedupeKey } from "@myrmidon/shared";

export type DiskOperatorKind = "disk_space" | "operator_action";

export interface DiskRecoverySignal {
  type: string;
  companyId?: string | null;
  mount?: string | null;
  scope?: string | null;
}

export interface OperatorActionSignal {
  action: string;
  scope?: string | null;
}

export interface DiskOperatorCause {
  kind: DiskOperatorKind;
  cause: string;
  scope: string;
  dedupeKey: string;
}

const diskRules = new Map<string, string>([
  ["host-disk:partition-critical", "partition_critical"],
  ["host-disk:partition-warn", "partition_warn"],
  ["host-disk:partition-refuse-open", "partition_refuses_open"],
  ["host-disk:partition-free-space", "partition_free_space"],
  ["host-disk:workspace-quota", "workspace_quota"],
  ["host-disk:workspace-quota-exceeded", "workspace_quota_exceeded"],
  ["host-disk:workspace-quota-near-limit", "workspace_quota_near_limit"],
  ["host-disk:inode-critical", "inode_critical"],
  ["host-disk:inode-warn", "inode_warn"],
  ["host-disk:docker-prune-required", "docker_prune_required"],
  ["host-disk:artifact-retention", "artifact_retention"],
  ["host-disk:logs-retention", "logs_retention"],
  ["host-disk:cache-retention", "cache_retention"],
  ["host-disk:volume-quota", "volume_quota"],
  ["host-disk:volume-quota-exceeded", "volume_quota_exceeded"],
]);

const operatorRules = new Map<string, string>([
  ["restart-ci", "restart_ci"],
  ["relay-branch", "branch_relay"],
  ["restore-review-participant", "review_participant_restore"],
  ["restore-execution-review", "execution_review_restore"],
  ["restore-github-access", "github_access_restore"],
  ["restore-myr-ws", "myr_ws_restore"],
  ["restore-devbuild", "devbuild_restore"],
  ["free-host-disk", "host_disk_free"],
  ["raise-host-quota", "host_quota_raise"],
]);

function result(kind: DiskOperatorKind, cause: string, scope: string): DiskOperatorCause {
  return { kind, cause, scope, dedupeKey: buildRecoveryDedupeKey({ kind, cause, scope }) };
}

export function classifyDiskRecoveryCause(signal: DiskRecoverySignal): DiskOperatorCause | null {
  const prefix = signal.type.split(":").slice(0, 3).join(":");
  const cause = diskRules.get(prefix) ?? diskRules.get(signal.type);
  if (!cause) return null;
  const scope = signal.scope ?? ([signal.companyId, signal.mount].filter(Boolean).join(":") || "host");
  return result("disk_space", cause, scope);
}

export function classifyOperatorAction(signal: OperatorActionSignal): DiskOperatorCause | null {
  const cause = operatorRules.get(signal.action);
  if (!cause) return null;
  return result("operator_action", cause, signal.scope ?? "operator");
}
