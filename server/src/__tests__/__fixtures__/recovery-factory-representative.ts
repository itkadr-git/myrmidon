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
// Every cause maps directly to its authoritative code contract or board incident record:
// - GitHub: verified runtime and board incidents (OPE-8225 description, OPE-8225 comment 3ca8264a,
//   OPE-7787 comment 72fe5dfd; see also server/src/services/recovery-factory/__fixtures__/github-signals.ts).
// - Workspace: authoritative myr-ws CLI contracts and runtime incidents:
//   * docker/bot-runtime/myr-ws/lib/open.js:234 (quotaRefusal: `${QUOTA_PREFIX} disk pressure is hard`)
//     and docs/myrmidon/changes/myr-ws-legacy-recovery.md:43 (BOT_DISK_QUOTA_EXCEEDED, exitCode 3).
//   * packages/shared/src/myrmidon-bot-workspace.ts:114, docker/bot-runtime/README.md:558, and
//     docs/myrmidon/changes/myr-ws-legacy-recovery.md:44 (repository over base limit, exitCode 4).
//   * docker/bot-runtime/myr-ws/lib/open.js:466 (PR #1427 / OPE-8295 legacy tree preservation).
//   * OPE-6415 description: devbuild environment variables missing in bot container.
// - Disk: verified board disk incidents (OPE-8215 description for devbuild storage ENOSPC,
//   OPE-6718 title/description for vm-core root 92%, OPE-7946 description for /srv/myrmidon-xfs 92%,
//   OPE-6415 / OPE-9254 description for container memory cgroup OOM-kills).
export const representativeRecoveryFixtures: readonly RepresentativeRecoveryFixture[] = [
  {
    id: "github-auth",
    group: "github",
    source: "OPE-8225 description: `gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent",
    signal: { message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent" },
    expectedKind: "github_access",
    expectedCause: "github_auth_missing",
  },
  {
    id: "github-rate-limit",
    group: "github",
    source: "OPE-8225 description / comment 3ca8264a-bca5-4b51-a71d-57122a877610; github-signals.ts:14",
    signal: { message: "anonymous GitHub API requests are rate-limited" },
    expectedKind: "github_access",
    expectedCause: "github_api_rate_limited",
  },
  {
    id: "github-run-auth",
    group: "github",
    source: "OPE-8225 description: /api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required",
    signal: { message: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required" },
    expectedKind: "github_access",
    expectedCause: "github_agent_auth_forbidden",
  },
  {
    id: "github-mtls",
    group: "github",
    source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54: Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent",
    signal: { message: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent" },
    expectedKind: "github_access",
    expectedCause: "github_broker_mtls_certificate_missing",
  },
  {
    id: "workspace-quota",
    group: "workspace",
    source: "docker/bot-runtime/myr-ws/lib/open.js:234 quotaRefusal contract; docs/myrmidon/changes/myr-ws-legacy-recovery.md:43; workspace-signals.ts:13",
    signal: { message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard", exitCode: 3 },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_quota_exceeded",
  },
  {
    id: "workspace-base",
    group: "workspace",
    source: "packages/shared/src/myrmidon-bot-workspace.ts:114; docs/myrmidon/changes/myr-ws-legacy-recovery.md:44; workspace-signals.ts:14",
    signal: { message: "myr-ws: repository over the base limit", exitCode: 4 },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_base_limit",
  },
  {
    id: "workspace-legacy",
    group: "workspace",
    source: "docker/bot-runtime/myr-ws/lib/open.js:466 (PR #1427 / OPE-8295); docs/myrmidon/changes/myr-ws-legacy-recovery.md:47; workspace-signals.ts:16",
    signal: { message: "could not preserve legacy working tree" },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_legacy_preservation_failed",
  },
  {
    id: "workspace-devbuild",
    group: "workspace",
    source: "OPE-6415 description: devbuild 'echo ok' -> «DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set»; workspace-signals.ts:20",
    signal: { message: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill" },
    expectedKind: "devbuild",
    expectedCause: "devbuild_configuration_missing",
  },
  {
    id: "disk-devbuild",
    group: "disk",
    source: "OPE-8215 description: mkdir cannot create directory /srv/devbuild/... No space left on device; OPE-7996 description; disk-operator-signals.ts:14",
    signal: { host: "devbuild", message: "mkdir: cannot create directory '/srv/devbuild/90192a57-8b26-4d3f-b65f-bd3fc7feda8b/OPE-8133': No space left on device" },
    expectedKind: "disk_space",
    expectedCause: "devbuild_receiver_full",
  },
  {
    id: "disk-root",
    group: "disk",
    source: "OPE-6718 title & description: vm-core: корень / 92% (23G свободно) — деградация записи в б; disk-operator-signals.ts:17",
    signal: { host: "vm-core", path: "/", usedPct: 92 },
    expectedKind: "disk_space",
    expectedCause: "host_root_low",
  },
  {
    id: "disk-workspace",
    group: "disk",
    source: "OPE-7946 description: alert /srv/myrmidon-xfs (тома ботов) 92% (211/230 ГБ); disk-operator-signals.ts:33",
    signal: { path: "/workspace/OPE-7946", message: "bot-volume alert /srv/myrmidon-xfs 92%: BOT_DISK_QUOTA_EXCEEDED" },
    expectedKind: "disk_space",
    expectedCause: "workspace_volume_full",
  },
  {
    id: "disk-container",
    group: "disk",
    source: "OPE-6415 description: 23 OOM-kill за неделю; OPE-9254 description; disk-operator-signals.ts:25",
    signal: { host: "container", message: "container OOMKilled: cgroup memory.max reached in bot execution" },
    expectedKind: "disk_space",
    expectedCause: "container_memory_or_tmp",
  },
];
