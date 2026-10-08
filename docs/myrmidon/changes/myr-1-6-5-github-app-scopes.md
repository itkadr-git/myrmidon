## changelog-en

### GitHub App permissions are set per App entry, Workflows can be allowed (GITHUB-APP-SCOPES)

- Every App entry in Company settings → Shared GitHub authorization now
  carries a permission list — `actions`, `checks`, `contents`, `deployments`,
  `environments`, `issues`, `pull_requests`, `workflows` — each `none` /
  `read` / `write`. The broker requests exactly that list on every
  installation token (`metadata: read` is always added, which GitHub grants
  to every token anyway); secrets, administration and organization keys are
  not on the allow-list and are rejected on save, so a stored document can
  never widen the broker beyond it. `workflows` is write-only — GitHub's
  token API has no `workflows: read`.
- The default is the historical fixed set (Contents + Pull requests write,
  everything else none), so an upgraded installation keeps minting exactly
  the tokens it minted before until the operator widens an entry.
- The permission list is part of the token cache key: widening an entry
  re-mints instead of reusing the narrower token. The issuance audit
  (`myrmidon.github_app.issued`) now records the permission list.
- To let agents edit `.github/workflows/*`: first enable **Workflows: Read
  and write** on the GitHub App registration and accept the updated
  permissions on the installation, then set **Workflows** to `write` on the
  App entry and save — no restart. The guide has the steps
  ([guides/github-shared-identity.md](guides/github-shared-identity.md)).

## changelog-ru

### Права GitHub App задаются на запись приложения, Workflows разрешается (GITHUB-APP-SCOPES)

- Каждая запись приложения в Настройках компании → Shared GitHub
  authorization теперь несёт список прав — `actions`, `checks`, `contents`,
  `deployments`, `environments`, `issues`, `pull_requests`, `workflows` —
  по каждому `none` / `read` / `write`. Брокер запрашивает ровно этот список
  в каждом токене установки (`metadata: read` добавляется всегда — его GitHub
  и так даёт каждому токену); Secrets, Administration и организационные ключи
  в allow-лист не входят и отклоняются при сохранении — хранимый документ не
  может расширить брокера за его границы. `workflows` — только `write`: у
  API токенов GitHub нет `workflows: read`.
- По умолчанию — исторический фиксированный набор (Contents + Pull requests
  `write`, остальное `none`), поэтому после обновления установка выдаёт ровно
  те же токены, что и раньше, пока оператор не расширит запись.
- Список прав входит в ключ кэша токенов: расширение записи приводит к новой
  выдаче, а не переиспользованию более узкого токена. Аудит выдачи
  (`myrmidon.github_app.issued`) теперь содержит список прав.
- Чтобы агенты правили `.github/workflows/*`: сначала включите **Workflows:
  Read and write** в регистрации приложения на GitHub и примите обновлённые
  права на установке, затем поставьте **Workflows** в `write` в записи
  приложения и сохраните — без перезапуска. Шаги — в руководстве
  ([guides/github-shared-identity.ru.md](guides/github-shared-identity.ru.md)).

## divergence-new

<!-- after: 1.6.3 — GITHUB-SHARED-IDENTITY: собственные GitHub App («авторизоваться один раз») -->

### 1.6.5 — GITHUB-APP-SCOPES: права GitHub App — список на запись приложения

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| GITHUB-APP-SCOPES | Вместо жёсткого набора `contents/pull_requests write + metadata read` каждый App entry в правилах общего GitHub-доступа несёт список прав (`actions`, `checks`, `contents`, `deployments`, `environments`, `issues`, `pull_requests`, `workflows`; `none`/`read`/`write`, `workflows` — только `write`). `access_tokens` запрашивает ровно его плюс `metadata: read`; ключи вне allow-листа (secrets, administration, орг-права) отклоняются схемой при PUT. По умолчанию — прежний набор; поведение несменённых установок не меняется. Список прав входит в ключ кэша токенов (расширение записи -> перевыдача) и в аудит `myrmidon.github_app.issued` | `server/src/myrmidon/github-shared-identity/{app-token,settings,resolve,index}.ts`, `ui/src/components/myrmidon/{GitHubSharedIdentityPanel.tsx,githubSharedIdentityApi.ts}`, доки `docs/myrmidon/guides/github-shared-identity{,.ru}.md` (наши) | Владелец: агентам нужно править CI (`.github/workflows/*`) там, где он разрешил; раньше брокер запрашивал фиксированный набор, и без Workflows в запросе токен не мог тронуть workflow-файлы | `server/src/__tests__/github-shared-identity.myrmidon.test.ts` (нормализация и маппинг списка, запрос ровно прав записи, перевыдача при расширении, аудит со списком, PUT-валидации 400/200), `ui/src/components/myrmidon/GitHubSharedIdentityPanel.myrmidon.test.tsx` (селекты прав, none/write у workflows, тело PUT) | Никогда, наше поведение. Снятие: вернуть константу прав в app-token.ts и убрать поле из схемы/панели | (этот PR) |

## settings-en-new

<!-- after: 1.6.3 — GITHUB-SHARED-IDENTITY: self-hosted GitHub Apps ("authorize once") -->

### 1.6.5 — GITHUB-APP-SCOPES: per-entry GitHub App permissions

| Field | Default | What it does |
|---|---|---|
| `apps[].permissions` | contents + pull requests `write`, all other keys `none` | The permission list the broker requests verbatim on every installation token of this App entry: each of `actions`, `checks`, `contents`, `deployments`, `environments`, `issues`, `pull_requests`, `workflows` is `none` (never requested), `read` or `write`; `metadata: read` is always added (GitHub grants it to every installation token), `workflows` is `write`-only. Keys outside this allow-list (secrets, administration, organization permissions) are rejected on save. Part of the token cache key — widening an entry re-mints. To let agents edit `.github/workflows/*`, enable Workflows on the App registration first, accept the updated permissions on the installation, then set `workflows: write` here. |

## settings-ru-new

<!-- after: 1.6.3 — GITHUB-SHARED-IDENTITY: собственные GitHub App («авторизоваться один раз») -->

### 1.6.5 — GITHUB-APP-SCOPES: права GitHub App на запись приложения

| Поле | Умолчание | Что делает |
|---|---|---|
| `apps[].permissions` | contents + pull requests `write`, остальные ключи `none` | Список прав, который брокер запрашивает дословно в каждом токене установки этого приложения: каждый из `actions`, `checks`, `contents`, `deployments`, `environments`, `issues`, `pull_requests`, `workflows` — `none` (не запрашивается), `read` или `write`; `metadata: read` добавляется всегда (GitHub даёт его каждому токену установки), `workflows` — только `write`. Ключи вне этого allow-листа (secrets, administration, орг-права) отклоняются при сохранении. Входит в ключ кэша токенов — расширение записи приводит к перевыдаче. Чтобы агенты правили `.github/workflows/*`, сначала включите Workflows в регистрации приложения и примите обновлённые права на установке, затем поставьте здесь `workflows: write`. |
