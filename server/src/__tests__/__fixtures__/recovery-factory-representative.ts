import type { RecoveryFactoryRequest } from "@myrmidon/shared";
import type { DiskRecoverySignal } from "../../services/recovery-factory/classify-disk-operator.js";
import type { GithubRecoverySignal } from "../../services/recovery-factory/classify-github.js";
import type { WorkspaceRecoverySignal } from "../../services/recovery-factory/classify-workspace.js";

type RepresentativeSignal =
  | { group: "github"; signal: GithubRecoverySignal }
  | { group: "workspace"; signal: WorkspaceRecoverySignal }
  | { group: "disk"; signal: DiskRecoverySignal };

export interface MeasuredSampleProvenance {
  /** The measured group partition from OPE-8312 §1, §2, §5.7 */
  measuredGroup: "github_38" | "workspace_31" | "disk_15";
  /** Aggregate count recorded in the ADM 24h audit on 19.10 02:00-02:30 */
  measuredCount: number;
  /** Primary board incident identifier */
  incidentId: string;
  /** Authoritative incident reference (comment ID, description section, or PR) */
  incidentReference: string;
  /** Sourced symptom or verbatim error message */
  observedSymptom: string;
}

export type RepresentativeRecoveryFixture = RepresentativeSignal & {
  id: string;
  source: string;
  expectedKind: RecoveryFactoryRequest["kind"];
  expectedCause: string;
  provenance: MeasuredSampleProvenance;
};

/**
 * Authoritative sampling artifact mapping the representative recovery causes
 * to the 38 GitHub, 31 workspace, and 15 disk blocked transitions measured
 * by ADM on 2026-10-19 02:00–02:30 Irkutsk and recorded in OPE-8312 §1, §2, §5.7.
 */
export const measuredSampleArtifact = {
  measuredAt: "2026-10-19 02:00-02:30 Irkutsk",
  designReference: "OPE-8312 §1, §2, §5.7",
  totalMeasuredBlockedTransitions: 144,
  categories: {
    github_38: {
      measuredCount: 38,
      description: "GitHub-доступ (OPE-7845, OPE-8225, OPE-7787)",
      sampledCauses: ["github-auth", "github-rate-limit", "github-run-auth", "github-mtls"],
    },
    workspace_31: {
      measuredCount: 31,
      description: "Рабочая копия myr-ws и devbuild (OPE-8294/8295, OPE-7946, OPE-6415)",
      sampledCauses: ["workspace-quota", "workspace-base", "workspace-legacy", "workspace-devbuild"],
    },
    disk_15: {
      measuredCount: 15,
      description: "Диск devbuild, root и тома ботов (OPE-8215, OPE-6718, OPE-7946, OPE-6415/9254)",
      sampledCauses: ["disk-devbuild", "disk-root", "disk-workspace", "disk-container"],
    },
  },
} as const;

export const representativeRecoveryFixtures: readonly RepresentativeRecoveryFixture[] = [
  {
    id: "github-auth",
    group: "github",
    source: "OPE-8225 description: `gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent",
    signal: { message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent" },
    expectedKind: "github_access",
    expectedCause: "github_auth_missing",
    provenance: {
      measuredGroup: "github_38",
      measuredCount: 38,
      incidentId: "OPE-8225",
      incidentReference: "OPE-8225 description: missing gh CLI host authentication",
      observedSymptom: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent",
    },
  },
  {
    id: "github-rate-limit",
    group: "github",
    source: "OPE-8225 description / comment 3ca8264a-bca5-4b51-a71d-57122a877610; github-signals.ts:14",
    signal: { message: "anonymous GitHub API requests are rate-limited" },
    expectedKind: "github_access",
    expectedCause: "github_api_rate_limited",
    provenance: {
      measuredGroup: "github_38",
      measuredCount: 38,
      incidentId: "OPE-8225",
      incidentReference: "OPE-8225 comment 3ca8264a-bca5-4b51-a71d-57122a877610: public API rate limit",
      observedSymptom: "anonymous GitHub API requests are rate-limited",
    },
  },
  {
    id: "github-run-auth",
    group: "github",
    source: "OPE-8225 description: /api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required",
    signal: { message: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required" },
    expectedKind: "github_access",
    expectedCause: "github_agent_auth_forbidden",
    provenance: {
      measuredGroup: "github_38",
      measuredCount: 38,
      incidentId: "OPE-8225",
      incidentReference: "OPE-8225 description: agent credentials endpoint rejected with HTTP 403",
      observedSymptom: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required",
    },
  },
  {
    id: "github-mtls",
    group: "github",
    source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54: Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent",
    signal: { message: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent" },
    expectedKind: "github_access",
    expectedCause: "github_broker_mtls_certificate_missing",
    provenance: {
      measuredGroup: "github_38",
      measuredCount: 38,
      incidentId: "OPE-7787",
      incidentReference: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54: broker client certificate rejection",
      observedSymptom: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent",
    },
  },
  {
    id: "workspace-quota",
    group: "workspace",
    source: "OPE-7946 description / OPE-8312 §2; docker/bot-runtime/myr-ws/lib/open.js:234 quotaRefusal contract; docs/myrmidon/changes/myr-ws-legacy-recovery.md:43",
    signal: { message: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard", exitCode: 3 },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_quota_exceeded",
    provenance: {
      measuredGroup: "workspace_31",
      measuredCount: 31,
      incidentId: "OPE-7946",
      incidentReference: "OPE-7946 description & OPE-8312 §2: bot-volume capacity exhaustion causing workspace refusal",
      observedSymptom: "BOT_DISK_QUOTA_EXCEEDED: disk pressure is hard (exitCode 3)",
    },
  },
  {
    id: "workspace-base",
    group: "workspace",
    source: "OPE-8294 / OPE-5312; packages/shared/src/myrmidon-bot-workspace.ts:114; docs/myrmidon/changes/myr-ws-legacy-recovery.md:44",
    signal: { message: "myr-ws: repository over the base limit", exitCode: 4 },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_base_limit",
    provenance: {
      measuredGroup: "workspace_31",
      measuredCount: 31,
      incidentId: "OPE-8294",
      incidentReference: "OPE-8294 / OPE-5312: repository size limit exceeded in myr-ws open",
      observedSymptom: "myr-ws: repository over the base limit (exitCode 4)",
    },
  },
  {
    id: "workspace-legacy",
    group: "workspace",
    source: "OPE-8294 description & OPE-8295 / PR #1427; docker/bot-runtime/myr-ws/lib/open.js:466; docs/myrmidon/changes/myr-ws-legacy-recovery.md:47",
    signal: { message: "could not preserve legacy working tree" },
    expectedKind: "workspace_myr_ws",
    expectedCause: "myr_ws_legacy_preservation_failed",
    provenance: {
      measuredGroup: "workspace_31",
      measuredCount: 31,
      incidentId: "OPE-8294",
      incidentReference: "OPE-8294 description & OPE-8295: legacy working tree unmanaged copy preservation failure",
      observedSymptom: "could not preserve legacy working tree",
    },
  },
  {
    id: "workspace-devbuild",
    group: "workspace",
    source: "OPE-6415 description: devbuild 'echo ok' -> «DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set»; workspace-signals.ts:20",
    signal: { message: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill" },
    expectedKind: "devbuild",
    expectedCause: "devbuild_configuration_missing",
    provenance: {
      measuredGroup: "workspace_31",
      measuredCount: 31,
      incidentId: "OPE-6415",
      incidentReference: "OPE-6415 description: missing devbuild environment variables in bot container",
      observedSymptom: "devbuild: DEVBUILD_HOST / DEVBUILD_USER / DEVBUILD_BASE are not set - see the devbuild skill",
    },
  },
  {
    id: "disk-devbuild",
    group: "disk",
    source: "OPE-8215 description / OPE-7996: mkdir cannot create directory /srv/devbuild/... No space left on device; disk-operator-signals.ts:14",
    signal: { host: "devbuild", message: "mkdir: cannot create directory '/srv/devbuild/90192a57-8b26-4d3f-b65f-bd3fc7feda8b/OPE-8133': No space left on device" },
    expectedKind: "disk_space",
    expectedCause: "devbuild_receiver_full",
    provenance: {
      measuredGroup: "disk_15",
      measuredCount: 15,
      incidentId: "OPE-8215",
      incidentReference: "OPE-8215 description: storage receiver full on devbuild build host (OPE-8312 «диск devbuild — 15»)",
      observedSymptom: "mkdir: cannot create directory '/srv/devbuild/90192a57-8b26-4d3f-b65f-bd3fc7feda8b/OPE-8133': No space left on device",
    },
  },
  {
    id: "disk-root",
    group: "disk",
    source: "OPE-6718 title & description: vm-core: корень / 92% (23G свободно) — деградация записи в б; disk-operator-signals.ts:17",
    signal: { host: "vm-core", path: "/", usedPct: 92 },
    expectedKind: "disk_space",
    expectedCause: "host_root_low",
    provenance: {
      measuredGroup: "disk_15",
      measuredCount: 15,
      incidentId: "OPE-6718",
      incidentReference: "OPE-6718 title & description: vm-core root filesystem low (92% used), causing DB ENOSPC",
      observedSymptom: "vm-core: корень / 92% (23G свободно) — деградация записи в б",
    },
  },
  {
    id: "disk-workspace",
    group: "disk",
    source: "OPE-7946 description: alert /srv/myrmidon-xfs (тома ботов) 92% (211/230 ГБ); disk-operator-signals.ts:33",
    signal: { path: "/workspace/OPE-7946", message: "bot-volume alert /srv/myrmidon-xfs 92%: BOT_DISK_QUOTA_EXCEEDED" },
    expectedKind: "disk_space",
    expectedCause: "workspace_volume_full",
    provenance: {
      measuredGroup: "disk_15",
      measuredCount: 15,
      incidentId: "OPE-7946",
      incidentReference: "OPE-7946 description: /srv/myrmidon-xfs (тома ботов) 92% alert, blocking bot allocations",
      observedSymptom: "bot-volume alert /srv/myrmidon-xfs 92%: BOT_DISK_QUOTA_EXCEEDED",
    },
  },
  {
    id: "disk-container",
    group: "disk",
    source: "OPE-6415 description / OPE-9254 description: 23 OOM-kill за неделю; disk-operator-signals.ts:25",
    signal: { host: "container", message: "container OOMKilled: cgroup memory.max reached in bot execution" },
    expectedKind: "disk_space",
    expectedCause: "container_memory_or_tmp",
    provenance: {
      measuredGroup: "disk_15",
      measuredCount: 15,
      incidentId: "OPE-9254",
      incidentReference: "OPE-9254 & OPE-6415 description: container cgroup memory.max OOM-kills during heavy builds",
      observedSymptom: "container OOMKilled: cgroup memory.max reached in bot execution",
    },
  },
];
