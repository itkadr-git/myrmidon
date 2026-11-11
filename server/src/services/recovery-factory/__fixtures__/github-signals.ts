import type { GithubRecoveryKind } from "../classify-github.js";

export interface GithubRecoveryFixture {
  source: string;
  message: string;
  kind: GithubRecoveryKind;
  cause: string;
}

// Exact incident wording and source references from the OPE-9135 evidence set.
export const githubRecoveryFixtures: readonly GithubRecoveryFixture[] = [
  {
    source: "OPE-8225 description",
    message: "`gh auth status` has no authenticated host, `GH_TOKEN`/`GITHUB_TOKEN` are absent",
    kind: "github_access",
    cause: "github_auth_missing",
  },
  {
    source: "OPE-8225 description",
    message: "anonymous GitHub API requests are rate-limited",
    kind: "github_access",
    cause: "github_api_rate_limited",
  },
  {
    source: "OPE-8225 description",
    message: "/api/agents/me/secrets returned HTTP 403 Run-bound agent authentication required",
    kind: "github_access",
    cause: "github_agent_auth_forbidden",
  },
  {
    source: "OPE-8225 comment 3ca8264a-bca5-4b51-a71d-57122a877610",
    message: "запущенный wrapper gh требует отсутствующий в образе node; gh auth status не запускается (node: not found)",
    kind: "github_access",
    cause: "github_cli_runtime_missing",
  },
  {
    source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54",
    message: "Credential broker отвергает запрос клиента HTTP 400: No required SSL certificate was sent",
    kind: "github_access",
    cause: "github_broker_mtls_certificate_missing",
  },
  {
    source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54",
    message: "публичный GitHub API отвечает 403 rate limit",
    kind: "github_access",
    cause: "github_api_rate_limited",
  },
  {
    source: "OPE-7787 comment 68ea0cd0-1925-456a-b9ee-66da27a7179a",
    message: "Запросы к credential broker в adm-run требуют mTLS client certificate",
    kind: "github_access",
    cause: "github_broker_mtls_certificate_missing",
  },
  {
    source: "OPE-7845 comment bc939edc-e369-4b9b-b8d9-bc0843068e8b",
    message: "shared GitHub App has `contents:write` and `pull_requests:write`, so it cannot meet this strict read-only request",
    kind: "github_access",
    cause: "github_app_permissions_exceed_read_only_policy",
  },
  {
    source: "OPE-7845 comment bc939edc-e369-4b9b-b8d9-bc0843068e8b",
    message: "I could not identify an App/identity owner or provision an isolated `contents:read`, `pull_requests:read` grant",
    kind: "github_access",
    cause: "github_read_only_grant_unavailable",
  },
  {
    source: "OPE-8079 comment 404b7a3c-2ae4-4466-bec7-e86389771c87",
    message: "Rerun-failed-jobs вернул 403 (workflow cannot be retried)",
    kind: "ci_restart",
    cause: "github_workflow_rerun_forbidden",
  },
  {
    source: "OPE-8079 comment 404b7a3c-2ae4-4466-bec7-e86389771c87",
    message: "установленный GitHub relay не имеет нужной identity/артефакта; проверка PR #972 выявила отсутствие целевого подтверждённого коммита",
    kind: "branch_relay",
    cause: "github_relay_identity_or_commit_missing",
  },
  {
    source: "OPE-8079 comment be02820e-95db-4f5f-ba42-de8a0deb0fb0",
    message: "единственный документированный вызов эскалации вернул 404",
    kind: "review_participant_restore",
    cause: "review_escalation_endpoint_not_found",
  },
  {
    source: "OPE-8079 comment 9f50a4bf-e979-4d74-9ba0-76093382895f",
    message: "Попытка принять её отклонена сервером: `interaction_human_only`",
    kind: "review_participant_restore",
    cause: "review_interaction_requires_human",
  },
  {
    source: "OPE-8079 comment 7a572709-9f6e-47a9-b7fc-6803c12e4f76",
    message: "OPE-7225 (blocked; execution review ещё не восстановлен)",
    kind: "review_participant_restore",
    cause: "execution_review_participant_not_restored",
  },
];

export const unknownGithubSignal = {
  source: "OPE-7787 comment 72fe5dfd-80b3-4296-a15f-ddcf00485f54 (non-GitHub boundary)",
  message: "checkout не содержит /workspace/OPE-6878/repo (путь отсутствует)",
};
