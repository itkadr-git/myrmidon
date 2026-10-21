---
settings-section: 1.6.3 — GITHUB-SHARED-IDENTITY: self-hosted GitHub Apps ("authorize once")
---

## settings-en

| `pats[]` | `[]` | Static GitHub PAT entries, independently scoped by `tokenSecretId` (active company secret), explicit `agentIds`, and `allowedRepos`. A PAT must never overlap an App or another PAT for the same agent/repository. |
| `pats[].tokenSecretId` | — | Active company secret holding the PAT. The broker resolves it per operation and never returns it in the identity summary. |
| `pats[].agentIds` | `[]` | Explicit agent UUID allowlist; empty means nobody. |
| `pats[].allowedRepos` | `[]` | Literal owner and repository pattern allowlist. PAT identity is selected only when both the agent and repository match. |

## settings-ru-append

<!-- section: 1.6.3 — GITHUB-SHARED-IDENTITY: собственные GitHub App («авторизоваться один раз») -->

| `pats[]` | `[]` | Статические GitHub PAT с отдельными `tokenSecretId` (активный секрет компании), явным `agentIds` и `allowedRepos`. PAT не должен пересекаться с App или другим PAT для того же агента и репозитория. |
| `pats[].tokenSecretId` | — | Активный секрет компании с PAT. Брокер разрешает его на каждую операцию и не возвращает токен в сводке identity. |
| `pats[].agentIds` | `[]` | Явный allowlist UUID агентов; пустой список никому не разрешает доступ. |
| `pats[].allowedRepos` | `[]` | Allowlist шаблонов owner/repository. PAT выбирается только при совпадении агента и репозитория. |
