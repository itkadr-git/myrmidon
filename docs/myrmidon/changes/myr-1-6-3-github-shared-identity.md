## changelog-en

### Authorize GitHub once for the whole server with our own GitHub Apps (GITHUB-SHARED-IDENTITY)

- Development agents could push only with an OAuth GitHub identity connected
  per person or per agent through the vendor's cloud connector and the
  vendor's GitHub App (a third party with write access to the code); bot
  containers strip raw tokens from the terminal, so agents without such an
  authorization could not push at all.
- Company settings → "Shared GitHub authorization"
  (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`)
  lists **our own GitHub Apps**: App id, private key (a company secret),
  installation, the agents (roles and/or agents) and the allowed
  repositories (`owner/repo` patterns). Applied without a restart.
- The board mints the installation tokens itself — no external broker — for
  the one target repository with contents/pull requests read-write and
  metadata read only. The App is picked by the target repository of each
  operation: products under different accounts never mix; a repository
  matched by no App stays absent, by two is an error. A dedicated per-agent
  grant (and the run's personal grant) still wins.
- The commit author and committer stay the agent; each issuance is audited
  (`myrmidon.github_app.issued`); the key and the token are never logged.
- The vendor cloud GitHub connector is **off by default**
  (`MYRMIDON_GITHUB_VENDOR_CONNECTOR=1` turns it on).
- Bot image: patch 09 keeps stripping raw tokens; `git-credential-paperclip`
  (`useHttpPath = true`) and the `gh` wrapper send the target repository to
  the broker. [guides/github-shared-identity.md](guides/github-shared-identity.md).

## changelog-ru

### Авторизоваться в GitHub один раз на весь сервер через свои GitHub App (GITHUB-SHARED-IDENTITY)

- Агенты разработки могли пушить только с OAuth-идентичностью GitHub на
  человека или агента через облачный коннектор вендора и GitHub App вендора
  (третья сторона с правом записи в код); контейнеры ботов вырезают сырые
  токены из терминала, поэтому агенты без такой авторизации не пушили вовсе.
- Настройки компании → «Shared GitHub authorization»
  (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`)
  перечисляют **наши собственные GitHub App**: App id, приватный ключ
  (секрет компании), установку, агентов (роли и/или агенты) и разрешённые
  репозитории (шаблоны `owner/repo`). Действует без перезапуска.
- Токены установки доска выпускает сама — без внешнего брокера — на один
  целевой репозиторий, только contents/pull requests на чтение-запись и
  metadata на чтение. Приложение выбирается по целевому репозиторию каждой
  операции: продукты под разными аккаунтами не смешиваются; репозиторий без
  совпадений — `absent`, с двумя — ошибка. Выделенный грант агента (и
  личный грант ответственного) по-прежнему главнее.
- Автор и коммиттер — агент; каждая выдача в аудите
  (`myrmidon.github_app.issued`); ключ и токен не логируются.
- Облачный GitHub-коннектор вендора **по умолчанию выключен**
  (`MYRMIDON_GITHUB_VENDOR_CONNECTOR=1` включает).
- Образ бота: патч 09 по-прежнему вырезает сырые токены;
  `git-credential-paperclip` (`useHttpPath = true`) и обёртка `gh` передают
  брокеру целевой репозиторий.
  [guides/github-shared-identity.ru.md](guides/github-shared-identity.ru.md).

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### 1.6.3 — GITHUB-SHARED-IDENTITY: собственные GitHub App («авторизоваться один раз»)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| GITHUB-SHARED-IDENTITY | Брокер GitHub прогона (`POST /runtime-tools/github/credentials`, тело `repository`), когда у прогона нет выделенного/личного/делегированного OAuth-гранта, выдаёт токен установки нашего собственного GitHub App: доска сама подписывает JWT ключом из секрета компании и вызывает `access_tokens` с одним репозиторием и правами contents/pull_requests write + metadata read. Приложение выбирается по целевому репозиторию (правила компании: агенты, шаблоны репозиториев); два совпадения — ошибка, ни одного — `absent`. Автор/коммиттер — агент (`commitIdentity`). Облачный GitHub-коннектор вендора по умолчанию выключен (`MYRMIDON_GITHUB_VENDOR_CONNECTOR`): новые подключения и OAuth-старт отклоняются, существующие подключения через него резолвер не видит. В образе бота хелпер `git-credential-paperclip` (`useHttpPath`) и обёртка `gh` передают репозиторий; патч 09 не меняется | Вендор, помечено `myrmidon(GITHUB-SHARED-IDENTITY)`: `server/src/services/git-credentials.ts` (фильтр подключений вендора, `noCandidate`, `commitIdentity`, источник `github_app`, репозиторий в брокер), `server/src/services/github-operation-credentials.ts` (`repository`, откат на App, `source: "app"`), `server/src/services/tool-access.ts` (три проверки выключателя коннектора), `server/src/routes/connection-intents.ts` (`repository` из тела), `server/src/routes/openapi.ts` (тело маршрута), `server/src/services/instance-settings.ts` (preserve-строка), `server/src/app.ts` (маршруты), `server/src/__tests__/setup-supertest.ts` (вендорские тесты идут с включённым коннектором), `packages/db/src/schema/run_identity_contexts.ts` и `packages/shared/src/types/heartbeat.ts` (тип `github.source`/`repository`), `ui/src/pages/CompanySettings.tsx` (панель), `docker/bot-runtime/github-broker/{git-credential-paperclip,gh,gitconfig}`; наши: `server/src/myrmidon/github-shared-identity/{settings,store,app-token,resolve,broker,vendor-connector,index}.ts`, `ui/src/components/myrmidon/{GitHubSharedIdentityPanel.tsx,githubSharedIdentityApi.ts}` | Владелец: авторизоваться один раз на весь сервер; без облачного коннектора и GitHub App вендора (третья сторона с записью в код); продукты под разными аккаунтами не смешиваются. Брокер знал только гранты на человека/агента через вендора, патч 09 вырезает токены из терминала — агенты без своей авторизации не могли пушить | `server/src/__tests__/github-shared-identity.myrmidon.test.ts` (JWT проверяется ключом приложения, токен на один репозиторий и минимальные права, кэш, авторство агента, аудит без токена и ключа, продукты A/B, ни одного/два совпадения, 404 GitHub, вне правил, выделенный главнее, выключенный коннектор вендора, тело маршрута, GET/PUT и права), `ui/src/components/myrmidon/GitHubSharedIdentityPanel.myrmidon.test.tsx`, `scripts/myrmidon/bot-runtime/github-broker-repository.test.mjs`, `docker/bot-runtime/tests/github_broker_run_scope.py` | Никогда, наше поведение (отказ от сервисов вендора). Снятие: удалить модуль, куски с маркером, строку в setup-supertest и разделы SETTINGS | (этот PR) |

## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->

### 1.6.3 — GITHUB-SHARED-IDENTITY: self-hosted GitHub Apps ("authorize once")

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_GITHUB_VENDOR_CONNECTOR` | GITHUB-SHARED-IDENTITY | unset (**off**) | Instance-wide switch of the vendor's cloud GitHub connector (OAuth through the vendor's GitHub App). Off: new managed GitHub connections and their OAuth start are refused (`github_vendor_connector_disabled`), existing vendor-connector GitHub connections are ignored by the credential resolver | `1`/`true`/`yes`/`on` — on (vendor behavior). Anything else — off. Read on every call |

Everything else is runtime-changeable per company. Company settings →
"Shared GitHub authorization" (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`;
GET: board with company access, PUT: board with `tools:manage_connections`)
edits `instance_settings.general.myrmidonGithubSharedIdentity[companyId]`:

| Field | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch. Off: no App serves anybody (the pre-change behavior). |
| `apps[].appId` | — | The id of our own GitHub App (registered with Contents and Pull requests read/write, Metadata read). |
| `apps[].privateKeySecretId` | — | Company secret (company scope, active) holding the App's private key PEM. Validated on save. |
| `apps[].installationId` | `null` | Installation id; `null` — discovered per repository (`GET /repos/{owner}/{repo}/installation`). |
| `apps[].roles` / `apps[].agentIds` | `[]` | Agents that may use the App (by role or id). Both empty: nobody. |
| `apps[].allowedRepos` | `[]` | `owner/repo` or `owner/<pattern with *>` the App serves; the owner is literal. The broker picks the App by the target repository of each operation; a repository matched by two Apps is an error. |
| `commitEmailDomain` | `null` (`agents.myrmidon.invalid`) | Domain of the agent's commit email `<agent-slug>@<domain>`. Author and committer stay the agent. |

The board mints installation tokens itself (RS256 JWT, `POST
/app/installations/{id}/access_tokens`), narrowed to the one target
repository and `contents: write, pull_requests: write, metadata: read`;
cached in memory until five minutes before expiry. Precedence: dedicated
(per-agent) grant > the run's personal grant > App. Audit:
`myrmidon.github_app.issued`/`denied`, secret access event with config path
`github_app:<owner/repo>`. In bot containers patch 09 keeps stripping raw
tokens; `git-credential-paperclip` (now with `useHttpPath = true`) and the
`gh` wrapper send the target repository to the broker. Full guide:
[guides/github-shared-identity.md](guides/github-shared-identity.md).

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.6.3 — GITHUB-SHARED-IDENTITY: собственные GitHub App («авторизоваться один раз»)

| Переменная | Функция | Умолчание | Что делает | Как отключить / особые случаи |
|---|---|---|---|---|
| `MYRMIDON_GITHUB_VENDOR_CONNECTOR` | GITHUB-SHARED-IDENTITY | не задана (**выключено**) | Выключатель облачного GitHub-коннектора вендора на весь экземпляр (OAuth через GitHub App вендора). Выключен: новые управляемые подключения GitHub и их OAuth-старт отклоняются (`github_vendor_connector_disabled`), существующие подключения GitHub через коннектор вендора резолвер учёток не видит | `1`/`true`/`yes`/`on` — включено (поведение вендора). Иное — выключено. Читается при каждом вызове |

Остальное меняется на лету, по компаниям. Настройки компании → «Shared
GitHub authorization» (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`;
GET — доска с доступом к компании, PUT — доска с правом
`tools:manage_connections`) правят
`instance_settings.general.myrmidonGithubSharedIdentity[companyId]`:

| Поле | Умолчание | Что делает |
|---|---|---|
| `enabled` | `false` | Общий выключатель. Выключен: приложения никому не выдаются (поведение до изменения). |
| `apps[].appId` | — | Id нашего GitHub App (зарегистрировано с правами Contents и Pull requests на чтение/запись, Metadata на чтение). |
| `apps[].privateKeySecretId` | — | Секрет компании (scope company, активный) с приватным ключом приложения (PEM). Проверяется при сохранении. |
| `apps[].installationId` | `null` | Id установки; `null` — находится по репозиторию (`GET /repos/{owner}/{repo}/installation`). |
| `apps[].roles` / `apps[].agentIds` | `[]` | Агенты, которым доступно приложение (по роли или id). Оба пусты — никому. |
| `apps[].allowedRepos` | `[]` | `owner/repo` или `owner/<шаблон с *>`, которые обслуживает приложение; владелец буквальный. Брокер выбирает приложение по целевому репозиторию каждой операции; репозиторий, совпавший с двумя приложениями, — ошибка. |
| `commitEmailDomain` | `null` (`agents.myrmidon.invalid`) | Домен почты коммитов агента `<slug-агента>@<домен>`. Автор и коммиттер — агент. |

Доска сама выпускает токены установки (JWT RS256, `POST
/app/installations/{id}/access_tokens`), суженные до одного целевого
репозитория и `contents: write, pull_requests: write, metadata: read`; в
памяти до пяти минут до истечения. Старшинство: выделенный (на агента)
грант > личный грант ответственного > приложение. Аудит:
`myrmidon.github_app.issued`/`denied`, событие доступа к секрету с путём
`github_app:<owner/repo>`. В контейнерах ботов патч 09 по-прежнему вырезает
сырые токены; `git-credential-paperclip` (теперь с `useHttpPath = true`) и
обёртка `gh` передают брокеру целевой репозиторий. Полное руководство:
[guides/github-shared-identity.ru.md](guides/github-shared-identity.ru.md).
