import { buildRecoveryDedupeKey } from "@myrmidon/shared";

export type GithubRecoveryKind =
  | "github_access"
  | "ci_restart"
  | "branch_relay"
  | "review_participant_restore";

export interface GithubRecoverySignal {
  message: string;
  repository?: string | null;
  pullRequest?: number | null;
}

export interface GithubRecoveryCause {
  kind: GithubRecoveryKind;
  cause: string;
  scope: string;
}

interface SignalRule {
  message: string;
  kind: GithubRecoveryKind;
  cause: string;
}

// Keep these rules tied to observed incidents; unknown provider wording must not
// create a misleading recovery issue.
const observedSignalRules: readonly SignalRule[] = [
  {
    message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent",
    kind: "github_access",
    cause: "github_auth_missing",
  },
  {
    message: "anonymous GitHub API requests are rate-limited",
    kind: "github_access",
    cause: "github_api_rate_limited",
  },
  {
    message: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required",
    kind: "github_access",
    cause: "github_agent_auth_forbidden",
  },
  {
    message: "запущенный wrapper gh требует отсутствующий в образе node; gh auth status не запускается (node: not found)",
    kind: "github_access",
    cause: "github_cli_runtime_missing",
  },
  {
    message: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent",
    kind: "github_access",
    cause: "github_broker_mtls_certificate_missing",
  },
  {
    message: "публичный GitHub API отвечает 403 rate limit",
    kind: "github_access",
    cause: "github_api_rate_limited",
  },
  {
    message: "Запросы к credential broker в adm-run требуют mTLS client certificate",
    kind: "github_access",
    cause: "github_broker_mtls_certificate_missing",
  },
  {
    message: "shared GitHub App has `contents:write` and `pull_requests:write`, so it cannot meet this strict read-only request",
    kind: "github_access",
    cause: "github_app_permissions_exceed_read_only_policy",
  },
  {
    message: "I could not identify an App/identity owner or provision an isolated `contents:read`, `pull_requests:read` grant",
    kind: "github_access",
    cause: "github_read_only_grant_unavailable",
  },
  {
    message: "Rerun-failed-jobs вернул 403 (workflow cannot be retried)",
    kind: "ci_restart",
    cause: "github_workflow_rerun_forbidden",
  },
  {
    message: "установленный GitHub relay не имеет нужной identity/артефакта; проверка PR #972 выявила отсутствие целевого подтверждённого коммита",
    kind: "branch_relay",
    cause: "github_relay_identity_or_commit_missing",
  },
  {
    message: "единственный документированный вызов эскалации вернул 404",
    kind: "review_participant_restore",
    cause: "review_escalation_endpoint_not_found",
  },
  {
    message: "Попытка принять её отклонена сервером: `interaction_human_only`",
    kind: "review_participant_restore",
    cause: "review_interaction_requires_human",
  },
  {
    message: "OPE-7225 (blocked; execution review ещё не восстановлен)",
    kind: "review_participant_restore",
    cause: "execution_review_participant_not_restored",
  },
];

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

/** Classifies only exact observed GitHub/review recovery signals. */
export function classifyGithubRecoveryCause(
  signal: GithubRecoverySignal,
): (GithubRecoveryCause & { dedupeKey: string }) | null {
  const normalized = normalizeMessage(signal.message);
  const match = observedSignalRules.find(
    (rule) => normalizeMessage(rule.message) === normalized,
  );
  if (!match) return null;

  const repository = signal.repository?.trim().toLowerCase();
  const pullRequest = signal.pullRequest;
  const scope = repository
    ? pullRequest == null
      ? repository
      : `${repository}#${pullRequest}`
    : "github:unspecified";
  return {
    kind: match.kind,
    cause: match.cause,
    scope,
    dedupeKey: buildRecoveryDedupeKey({
      kind: match.kind,
      scope,
      cause: match.cause,
    }),
  };
}
