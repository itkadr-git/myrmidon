
export type RecoveryDiskCause = "devbuild_receiver_full" | "host_root_low" | "workspace_volume_full" | "container_memory_or_tmp" | "docker_storage_low";
export type RecoveryOperatorCause = "ci_rerun" | "ci_access" | "review_route" | "review_participant_restore" | "branch_relay" | "head_decision" | "infra_config";

export interface RecoverySignal {
  action?: string;
  message?: string;
  prNumber?: number;
  headSha?: string;
  issueId?: string;
}

export interface DiskRecoverySignal {
  usedPct?: number;
  freeBytes?: number;
  path?: string;
  host?: string;
  message?: string;
}

export interface DiskRecoveryClassification {
  kind: "disk_space";
  cause: RecoveryDiskCause;
  scope: "devbuild" | "vmcore_root" | "workspace" | "container" | "docker";
}

export interface OperatorRecoveryClassification {
  kind: "operator_action";
  cause: RecoveryOperatorCause;
  scope: "operator";
}

export type RecoveryClassification = DiskRecoveryClassification | OperatorRecoveryClassification;

const diskCauseScopes: Record<RecoveryDiskCause, DiskRecoveryClassification["scope"]> = {
  devbuild_receiver_full: "devbuild",
  host_root_low: "vmcore_root",
  workspace_volume_full: "workspace",
  container_memory_or_tmp: "container",
  docker_storage_low: "docker",
};

const DISK_GIB = 1024 ** 3;
const DEVBUILD_MIN_FREE_BYTES = 10 * DISK_GIB;
const VMCORE_MIN_FREE_BYTES = 20 * DISK_GIB;
const VMCORE_MIN_USED_PCT = 90;

function classification(cause: RecoveryDiskCause): DiskRecoveryClassification {
  return { kind: "disk_space", cause, scope: diskCauseScopes[cause] };
}

const operatorActions: Readonly<Record<string, RecoveryOperatorCause>> = {
  ci_rerun: "ci_rerun",
  ci_access: "ci_access",
  review_route: "review_route",
  review_participant_restore: "review_participant_restore",
  branch_relay: "branch_relay",
  head_decision: "head_decision",
  infra_config: "infra_config",
};

const operatorMessageRules: readonly { cause: RecoveryOperatorCause; pattern: RegExp }[] = [
  { cause: "ci_rerun", pattern: /\b(?:re-?run|restart|fresh)\b.{0,40}\bCI\b|\bCI\b.{0,40}\b(?:re-?run|restart|fresh)\b/i },
  { cause: "ci_access", pattern: /\b(?:scoped|grant|provide|restore)\b.{0,40}\bCI\b.{0,40}\b(?:access|permission|slot|runner)\b|\b(?:CI access|CI permission|CI slot|build slot|runner access)\b/i },
  { cause: "review_route", pattern: /\b(?:review|reviewer)\b.{0,40}\b(?:route|routing|assign|assignment)\b/i },
  { cause: "review_participant_restore", pattern: /\b(?:restore|recover)\b.{0,40}\b(?:review participant|review runtime)\b|\b(?:review participant|review runtime)\b.{0,40}\b(?:restore|recover)\b/i },
  { cause: "branch_relay", pattern: /\b(?:relay|transfer)\b.{0,40}\b(?:branch|artifact)\b|\b(?:branch|artifact)\b.{0,40}\b(?:relay|transfer)\b/i },
  { cause: "head_decision", pattern: /\b(?:decision|decide)\b.{0,40}\bhead\b|\bhead\b.{0,40}\b(?:decision|decide)\b/i },
  { cause: "infra_config", pattern: /\b(?:instance|egress|quota)\b.{0,40}\b(?:config|configuration|limit)\b|\b(?:config|configuration)\b.{0,40}\b(?:instance|egress|quota)\b/i },
];

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function classifyDiskSignal(signal: DiskRecoverySignal): DiskRecoveryClassification | null {
  const message = normalized(signal.message);
  const path = normalized(signal.path);
  const host = normalized(signal.host);
  const isEnospc = message.includes("enospc") || message.includes("no space left on device") || message.includes("disk full");
  const devbuildOutput = host === "devbuild" || message.includes("devbuild") || /\brsync\b/.test(message);
  const devbuildMatch = isEnospc && devbuildOutput;
  const devbuildLow = host === "devbuild" && signal.freeBytes != null && signal.freeBytes < DEVBUILD_MIN_FREE_BYTES;
  const rootSignal = path === "/" || path === "vmcore_root";
  const vmcoreRoot = rootSignal && host === "vm-core";
  const conflictingHostAndPath = rootSignal && host === "devbuild";
  if (conflictingHostAndPath) return null;
  const vmcoreLow = vmcoreRoot && ((signal.usedPct != null && signal.usedPct >= VMCORE_MIN_USED_PCT)
    || (signal.freeBytes != null && signal.freeBytes < VMCORE_MIN_FREE_BYTES));
  const workspace = path === "/workspace" || path.startsWith("/workspace/");
  const workspaceFull = workspace && (isEnospc || /\bquota\b/.test(message) || message.includes("bot_disk_quota_exceeded"));
  const containerPath = path === "/tmp" || path.startsWith("/tmp/");
  const containerFull = (containerPath && message.includes("tmpfs"))
    || ((message.includes("oom") || message.includes("memory.max") || message.includes("cgroup memory"))
      && (host === "container" || message.includes("container")));
  const dockerFull = message.includes("docker")
    && (isEnospc || message.includes("pull") || message.includes("extract") || message.includes("system df"));

  const candidates: DiskRecoveryClassification[] = [];
  if (devbuildMatch || devbuildLow) candidates.push(classification("devbuild_receiver_full"));
  if (vmcoreLow) candidates.push(classification("host_root_low"));
  if (workspaceFull) candidates.push(classification("workspace_volume_full"));
  if (containerFull) candidates.push(classification("container_memory_or_tmp"));
  if (dockerFull) candidates.push(classification("docker_storage_low"));
  return candidates.length === 1 ? candidates[0]! : null;
}

export function classifyDiskRecoveryCause(signal: DiskRecoverySignal): DiskRecoveryClassification | null {
  return classifyDiskSignal(signal);
}

export function classifyOperatorAction(signal: RecoverySignal): OperatorRecoveryClassification | null {
  const explicitAction = signal.action?.trim().toLowerCase();
  if (explicitAction) {
    const cause = Object.hasOwn(operatorActions, explicitAction) ? operatorActions[explicitAction] : undefined;
    return cause ? { kind: "operator_action", cause, scope: "operator" } : null;
  }
  const message = signal.message?.trim();
  if (!message) return null;
  const normalizedMessage = message.toLowerCase();
  const matchedRules = operatorMessageRules.filter(rule => rule.pattern.test(normalizedMessage));
  if (matchedRules.length !== 1) return null;
  return { kind: "operator_action", cause: matchedRules[0]!.cause, scope: "operator" };
}
export function buildRecoveryDedupeKey(
  result: Pick<RecoveryClassification, "kind" | "cause" | "scope">,
  signal: RecoverySignal,
): string {
  const identity = signal.prNumber ?? signal.headSha ?? signal.issueId ?? "";
  return `${result.kind}:${result.cause}:${result.scope}:${identity}`;
}