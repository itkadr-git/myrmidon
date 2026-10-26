import type { WorkspaceRecoveryKind } from "../classify-workspace.js";

export interface WorkspaceRecoveryFixture {
  source: string;
  message: string;
  exitCode?: number;
  kind: WorkspaceRecoveryKind;
  cause: string;
}

// Production wording from myr-ws exit contracts and the devbuild wrapper.
export const workspaceRecoveryFixtures: readonly WorkspaceRecoveryFixture[] = [
  { source: "myr-ws quota contract", exitCode: 3, message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard", kind: "workspace_myr_ws", cause: "myr_ws_quota_exceeded" },
  { source: "myr-ws base limit", exitCode: 4, message: "myr-ws: repository over the base limit", kind: "workspace_myr_ws", cause: "myr_ws_base_limit" },
  { source: "myr-ws git error", exitCode: 5, message: "git fetch failed: remote unavailable", kind: "workspace_myr_ws", cause: "myr_ws_network_failure" },
  { source: "myr-ws legacy recovery", message: "could not preserve legacy working tree", kind: "workspace_myr_ws", cause: "myr_ws_legacy_preservation_failed" },
  { source: "myr-ws legacy recovery", message: "legacy path already exists", kind: "workspace_myr_ws", cause: "myr_ws_legacy_path_exists" },
  { source: "myr-ws recovery ref validation", message: "recovery ref could not be verified", kind: "workspace_myr_ws", cause: "myr_ws_recovery_snapshot_failed" },
  { source: "myr-ws recovery stash", message: "could not stash local changes before switching to bot/OPE-1; saved to refs/myr-ws/recovery/OPE-1", kind: "workspace_myr_ws", cause: "myr_ws_recovery_stash_failed" },
  { source: "myr-ws recovery branch switch", message: "cannot switch to bot/OPE-1: checkout failed; saved to refs/myr-ws/recovery/OPE-1", kind: "workspace_myr_ws", cause: "myr_ws_recovery_branch_switch_failed" },
  { source: "devbuild env contract", message: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill", kind: "devbuild", cause: "devbuild_configuration_missing" },
  { source: "devbuild workspace validation", message: "devbuild: workspace directory /workspace/OPE-1 does not exist", kind: "devbuild", cause: "devbuild_workspace_missing" },
  { source: "devbuild SSH key validation", message: "devbuild: ssh key /opt/devbuild-ssh/id_ed25519 is missing or not readable - see the devbuild skill", kind: "devbuild", cause: "devbuild_ssh_key_missing" },
  { source: "devbuild dependency validation", message: "devbuild: rsync is not installed in this image", kind: "devbuild", cause: "devbuild_rsync_missing" },
  { source: "devbuild scratch validation", message: "devbuild: cannot create the private key directory under /run/scratch", kind: "devbuild", cause: "devbuild_scratch_unavailable" },
  { source: "devbuild transfer", message: "devbuild: rsync to build-host failed", kind: "devbuild", cause: "devbuild_sync_failed" },
  { source: "devbuild remote execution", message: "devbuild: ssh to build-host failed", kind: "devbuild", cause: "devbuild_ssh_failed" },
];
