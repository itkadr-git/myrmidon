import { buildRecoveryDedupeKey } from "@myrmidon/shared";

export type WorkspaceRecoveryKind = "workspace_myr_ws" | "devbuild";

export interface WorkspaceRecoverySignal {
  message: string;
  exitCode?: number | null;
}

export interface WorkspaceRecoveryCause {
  kind: WorkspaceRecoveryKind;
  cause: string;
  scope: string;
  dedupeKey: string;
}

interface SignalRule {
  kind: WorkspaceRecoveryKind;
  cause: string;
  matches: (signal: WorkspaceRecoverySignal) => boolean;
}

const observedSignalRules: readonly SignalRule[] = [
  { kind: "workspace_myr_ws", cause: "myr_ws_quota_exceeded", matches: s => s.exitCode === 3 && s.message.startsWith("BOT_DISK_QUOTA_EXCEEDED:") },
  { kind: "workspace_myr_ws", cause: "myr_ws_base_limit", matches: s => s.exitCode === 4 && s.message.startsWith("myr-ws: repository over the base limit") },
  { kind: "workspace_myr_ws", cause: "myr_ws_network_failure", matches: s => s.exitCode === 5 && /^(?:myr-ws: )?(?:git .* failed:|cannot run git:|ensureBase returned no base path)/.test(s.message) },
  { kind: "workspace_myr_ws", cause: "myr_ws_unpushed_work", matches: s => s.exitCode === 7 && /unpushed work/.test(s.message) },
  { kind: "workspace_myr_ws", cause: "myr_ws_legacy_preservation_failed", matches: s => s.message.includes("could not preserve legacy working tree") || s.message.includes("could not verify preserved legacy working tree") },
  { kind: "workspace_myr_ws", cause: "myr_ws_legacy_path_exists", matches: s => s.message.includes("legacy path already exists") },
  { kind: "workspace_myr_ws", cause: "myr_ws_recovery_snapshot_failed", matches: s => s.message.includes("recovery ref could not be verified") || s.message.includes("too many recovery refs under") },
  { kind: "workspace_myr_ws", cause: "myr_ws_recovery_stash_failed", matches: s => s.message.includes("could not stash local changes before switching") },
  { kind: "workspace_myr_ws", cause: "myr_ws_recovery_branch_switch_failed", matches: s => s.message.includes("cannot switch to") && s.message.includes("saved to refs/myr-ws/recovery/") },
  { kind: "devbuild", cause: "devbuild_configuration_missing", matches: s => s.message.includes("DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set") },
  { kind: "devbuild", cause: "devbuild_workspace_missing", matches: s => s.message.startsWith("devbuild: workspace directory ") && s.message.endsWith(" does not exist") },
  { kind: "devbuild", cause: "devbuild_ssh_key_missing", matches: s => s.message.startsWith("devbuild: ssh key ") && s.message.endsWith(" is missing or not readable - see the devbuild skill") },
  { kind: "devbuild", cause: "devbuild_rsync_missing", matches: s => s.message === "devbuild: rsync is not installed in this image" },
  { kind: "devbuild", cause: "devbuild_scratch_unavailable", matches: s => s.message.startsWith("devbuild: cannot create the private key directory under ") },
  { kind: "devbuild", cause: "devbuild_sync_failed", matches: s => s.message.startsWith("devbuild: rsync to ") && s.message.endsWith(" failed") },
  { kind: "devbuild", cause: "devbuild_ssh_failed", matches: s => s.message.startsWith("devbuild: ssh to ") && s.message.endsWith(" failed") },
];

/** Classifies only structured exit codes or observed myr-ws/devbuild errors. */
export function classifyWorkspaceRecoveryCause(
  signal: WorkspaceRecoverySignal,
): WorkspaceRecoveryCause | null {
  const match = observedSignalRules.find(rule => rule.matches(signal));
  if (!match) return null;
  const scope = "workspace:unspecified";
  return {
    kind: match.kind,
    cause: match.cause,
    scope,
    dedupeKey: buildRecoveryDedupeKey({ kind: match.kind, scope, cause: match.cause }),
  };
}
