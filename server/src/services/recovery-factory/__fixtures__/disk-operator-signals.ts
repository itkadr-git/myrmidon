import type { DiskRecoverySignal, RecoveryOperatorCause, RecoverySignal, RecoveryDiskCause } from "../classify-disk-operator.js";

export interface DiskSignalFixture {
  source: string;
  signal: DiskRecoverySignal;
  cause: RecoveryDiskCause;
  scope: "devbuild" | "vmcore_root" | "workspace" | "container" | "docker";
}

export const diskRecoveryFixtures: readonly (DiskSignalFixture | {
  source: string;
  signal: DiskRecoverySignal;
  expected: null;
})[] = [
  { source: "devbuild rsync ENOSPC", signal: { host: "devbuild", message: "devbuild rsync: write failed: No space left on device (ENOSPC)" }, cause: "devbuild_receiver_full", scope: "devbuild" },
  { source: "devbuild disk-full output", signal: { host: "devbuild", message: "devbuild receiver: disk full during transfer" }, cause: "devbuild_receiver_full", scope: "devbuild" },
  { source: "devbuild ENOSPC with host", signal: { host: "devbuild", message: "No space left on device" }, cause: "devbuild_receiver_full", scope: "devbuild" },
  { source: "vm-core root at used threshold", signal: { host: "vm-core", path: "/", usedPct: 90 }, cause: "host_root_low", scope: "vmcore_root" },
  { source: "vm-core root below used threshold", signal: { host: "vm-core", path: "/", usedPct: 89 }, expected: null },
  { source: "vm-core root below free threshold", signal: { host: "vm-core", path: "/", freeBytes: 20 * 1024 ** 3 }, expected: null },
  { source: "vm-core root above free threshold", signal: { host: "vm-core", path: "/", freeBytes: 19 * 1024 ** 3 }, cause: "host_root_low", scope: "vmcore_root" },
  { source: "container cgroup memory.max", signal: { message: "container OOMKilled: cgroup memory.max reached" }, cause: "container_memory_or_tmp", scope: "container" },
  { source: "container tmpfs", signal: { path: "/tmp", message: "tmpfs is full in container" }, cause: "container_memory_or_tmp", scope: "container" },
  { source: "container OOM under cgroup memory limit", signal: { message: "container OOM event after cgroup memory limit" }, cause: "container_memory_or_tmp", scope: "container" },
  { source: "docker image extraction no-space", signal: { message: "docker pull failed: no space while extracting image layer" }, cause: "docker_storage_low", scope: "docker" },
  { source: "docker system df threshold signal", signal: { message: "docker system df storage above configured threshold" }, cause: "docker_storage_low", scope: "docker" },
  { source: "devbuild receiver free-space threshold", signal: { host: "devbuild", freeBytes: 9 * 1024 ** 3 }, cause: "devbuild_receiver_full", scope: "devbuild" },
  { source: "workspace myr-ws hard quota", signal: { path: "/workspace/OPE-1", message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard" }, cause: "workspace_volume_full", scope: "workspace" },
  { source: "workspace myr-ws capacity limit", signal: { path: "/workspace/OPE-1", message: "myr-ws: repository over the base quota limit" }, cause: "workspace_volume_full", scope: "workspace" },
];

export const operatorRecoveryFixtures: readonly {
  source: string;
  signal: RecoverySignal;
  cause: RecoveryOperatorCause;
  scope: "operator";
}[] = [
  { source: "OPE-7969 CI rerun", signal: { action: "ci_rerun", issueId: "OPE-7969" }, cause: "ci_rerun", scope: "operator" },
  { source: "OPE-7710 scoped CI access", signal: { action: "ci_access", issueId: "OPE-7710" }, cause: "ci_access", scope: "operator" },
  { source: "OPE-7590 review route", signal: { action: "review_route", issueId: "OPE-7590" }, cause: "review_route", scope: "operator" },
  { source: "OPE-6871 review route", signal: { action: "review_route", issueId: "OPE-6871" }, cause: "review_route", scope: "operator" },
  { source: "OPE-7225 restore review participant", signal: { action: "review_participant_restore", issueId: "OPE-7225" }, cause: "review_participant_restore", scope: "operator" },
  { source: "OPE-7533 branch relay", signal: { action: "branch_relay", issueId: "OPE-7533" }, cause: "branch_relay", scope: "operator" },
  { source: "OPE-6001 head decision", signal: { action: "head_decision", issueId: "OPE-6001" }, cause: "head_decision", scope: "operator" },
  { source: "OPE-7265 head decision", signal: { action: "head_decision", issueId: "OPE-7265" }, cause: "head_decision", scope: "operator" },
  { source: "OPE-7975 infrastructure config", signal: { action: "infra_config", issueId: "OPE-7975" }, cause: "infra_config", scope: "operator" },
];
