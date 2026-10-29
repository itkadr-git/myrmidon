import type { RecoveryFactoryRequest } from "@myrmidon/shared";
import type { DiskRecoverySignal } from "../../services/recovery-factory/classify-disk-operator.js";
import type { GithubRecoverySignal } from "../../services/recovery-factory/classify-github.js";
import type { WorkspaceRecoverySignal } from "../../services/recovery-factory/classify-workspace.js";

type RepresentativeSignal =
  | { group: "github"; signal: GithubRecoverySignal }
  | { group: "workspace"; signal: WorkspaceRecoverySignal }
  | { group: "disk"; signal: DiskRecoverySignal };

export type RepresentativeRecoveryFixture = RepresentativeSignal & {
  id: string;
  source: string;
  expectedKind: RecoveryFactoryRequest["kind"];
  expectedCause: string;
};

// Representative sample of 12 verified incident causes across the 38 GitHub,
// 31 workspace, and 15 disk blocked incident categories measured in OPE-8312 §5.7.
// All signals are sourced from verified board incident issues and comments
// (OPE-8225, OPE-7787, OPE-7946, OPE-8294, OPE-8295, OPE-6415, OPE-7996, OPE-6718, OPE-4982, OPE-9254).
export const representativeRecoveryFixtures: readonly RepresentativeRecoveryFixture[] = [
  {
    id: "github-auth", group: "github", source: "OPE-8225 description",
    signal: { message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent" },
    expectedKind: "github_access", expectedCause: "github_auth_missing",
  },
  {
    id: "github-rate-limit", group: "github", source: "OPE-8225 comment 3ca8264a-bca5-4b51-a71d-57122a877610",
    signal: { message: "anonymous GitHub API requests are rate-limited" },
    expectedKind: "github_access", expectedCause: "github_api_rate_limited",
  },
  {
    id: "github-run-auth", group: "github", source: "OPE-8225 description",
    signal: { message: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required" },
    expectedKind: "github_access", expectedCause: "github_agent_auth_forbidden",
  },
  {
    id: "github-mtls", group: "github", source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54",
    signal: { message: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent" },
    expectedKind: "github_access", expectedCause: "github_broker_mtls_certificate_missing",
  },
  {
    id: "workspace-quota", group: "workspace", source: "OPE-7946 description: myr-ws BOT_DISK_QUOTA_EXCEEDED",
    signal: { message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard", exitCode: 3 },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_quota_exceeded",
  },
  {
    id: "workspace-base", group: "workspace", source: "OPE-8294 description; OPE-5312 H5: myr-ws repository over base limit",
    signal: { message: "myr-ws: repository over the base limit", exitCode: 4 },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_base_limit",
  },
  {
    id: "workspace-legacy", group: "workspace", source: "OPE-8295 description; PR #1427: myr-ws could not preserve legacy working tree",
    signal: { message: "could not preserve legacy working tree" },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_legacy_preservation_failed",
  },
  {
    id: "workspace-devbuild", group: "workspace", source: "OPE-6415 description: devbuild environment variables missing",
    signal: { message: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill" },
    expectedKind: "devbuild", expectedCause: "devbuild_configuration_missing",
  },
  {
    id: "disk-devbuild", group: "disk", source: "OPE-7996 description; OPE-8215 description: devbuild storage ENOSPC",
    signal: { host: "devbuild", message: "ERR_PNPM_ENOSPC" },
    expectedKind: "disk_space", expectedCause: "devbuild_receiver_full",
  },
  {
    id: "disk-root", group: "disk", source: "OPE-6718 description: vm-core root at 92 percent (ENOSPC activity_log)",
    signal: { host: "vm-core", path: "/", usedPct: 92 },
    expectedKind: "disk_space", expectedCause: "host_root_low",
  },
  {
    id: "disk-workspace", group: "disk", source: "OPE-7946 description; OPE-4982 description: workspace volume pressure",
    signal: { path: "/workspace/OPE-9143", message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard" },
    expectedKind: "disk_space", expectedCause: "workspace_volume_full",
  },
  {
    id: "disk-container", group: "disk", source: "OPE-9254 description: container OOM-kill under cgroup memory limit",
    signal: { host: "container", message: "408 OOM-kill" },
    expectedKind: "disk_space", expectedCause: "container_memory_or_tmp",
  },
];
