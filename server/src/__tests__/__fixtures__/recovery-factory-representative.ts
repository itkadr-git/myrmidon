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

// Board excerpts were read through the authenticated issue API. Wrapper errors
// are emitted contracts, not invented incident counts. The 38/31/15 figures are
// aggregate cases, not distinct cause counts (OPE-8312; ADM's disk clarification).
export const representativeRecoveryFixtures: readonly RepresentativeRecoveryFixture[] = [
  {
    id: "github-auth", group: "github", source: "OPE-8225 description",
    signal: { message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent" },
    expectedKind: "github_access", expectedCause: "github_auth_missing",
  },
  {
    id: "github-rate-limit", group: "github", source: "OPE-8225 description",
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
    signal: { message: "Credential broker \u043e\u0442\u0432\u0435\u0440\u0433\u0430\u0435\u0442 \u0437\u0430\u043f\u0440\u043e\u0441 \u043a\u043b\u0438\u0435\u043d\u0442\u0430 HTTP 400: No required SSL certificate was sent" },
    expectedKind: "github_access", expectedCause: "github_broker_mtls_certificate_missing",
  },
  {
    id: "workspace-quota", group: "workspace", source: "OPE-9136 emitted myr-ws quota contract; services/recovery-factory/__fixtures__/workspace-signals.ts",
    signal: { message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard", exitCode: 3 },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_quota_exceeded",
  },
  {
    id: "workspace-base", group: "workspace", source: "OPE-9136 emitted myr-ws base-limit contract; services/recovery-factory/__fixtures__/workspace-signals.ts",
    signal: { message: "myr-ws: repository over the base limit", exitCode: 4 },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_base_limit",
  },
  {
    id: "workspace-legacy", group: "workspace", source: "OPE-9136 emitted myr-ws legacy-recovery contract; services/recovery-factory/__fixtures__/workspace-signals.ts",
    signal: { message: "could not preserve legacy working tree" },
    expectedKind: "workspace_myr_ws", expectedCause: "myr_ws_legacy_preservation_failed",
  },
  {
    id: "workspace-devbuild", group: "workspace", source: "OPE-9136 emitted devbuild environment contract; services/recovery-factory/__fixtures__/workspace-signals.ts",
    signal: { message: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill" },
    expectedKind: "devbuild", expectedCause: "devbuild_configuration_missing",
  },
  {
    id: "disk-devbuild", group: "disk", source: "OPE-6688 description: ERR_PNPM_ENOSPC on devbuild; ADM contract OPE-9137 comment c1876c6b-a6c3-4adf-a145-6e26e467caf5",
    signal: { host: "devbuild", message: "ERR_PNPM_ENOSPC" },
    expectedKind: "disk_space", expectedCause: "devbuild_receiver_full",
  },
  {
    id: "disk-root", group: "disk", source: "OPE-6718 description: vm-core root at 92 percent",
    signal: { host: "vm-core", path: "/", usedPct: 92 },
    expectedKind: "disk_space", expectedCause: "host_root_low",
  },
  {
    id: "disk-workspace", group: "disk", source: "OPE-9136 myr-ws quota contract; ADM contract OPE-9137 comment c1876c6b-a6c3-4adf-a145-6e26e467caf5",
    signal: { path: "/workspace/OPE-9143", message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard" },
    expectedKind: "disk_space", expectedCause: "workspace_volume_full",
  },
  {
    id: "disk-container", group: "disk", source: "OPE-9254 description: 408 OOM-kill",
    signal: { host: "container", message: "408 OOM-kill" },
    expectedKind: "disk_space", expectedCause: "container_memory_or_tmp",
  },
];
