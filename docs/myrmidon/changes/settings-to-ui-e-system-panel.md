## changelog-en

### System and monitoring settings in the interface (SETTINGS-TO-UI E)

- The system/monitoring toggles moved from the environment to the settings
  UI: deploy smoke parameters (enabled, autoRollback, autoUpdate,
  verifyTimeoutSec, tickSec, stepTimeoutSec, healthPollSec, healthTimeoutSec),
  tracing health windows (windowSec, healthTtlSec, signalIntervalSec) and the
  Zabbix maintenance settings (hostGroups, maxWindowSec) are registered in the
  behavior-settings registry (instance scope, section `system`) and edited on
  Instance → General in the new **System** panel.
- Consumers resolve the values live — the deploy-jobs service, index and
  settings, the tracing-health probes, attention sweep and routes, the
  maintenance Zabbix hooks — so a change in the interface applies without a
  restart. A set `MYRMIDON_*` variable stays the forced override; otherwise
  the saved value applies, otherwise the default. The API and the panel show
  the source of each effective value.
- New read-only surface `GET /api/myrmidon/system/deployment` (board and agent
  may read, anonymous callers get 403): reports which infrastructure
  integrations are configured — presence for secret references, the host for
  URLs — never the values themselves; shown as the read-only **Deployment**
  block of the same panel.
- Hindsight is not duplicated in the registry: it stays on the existing agent
  memory instance setting with its secrets-store picker.

## changelog-ru

### Системные настройки и мониторинг в интерфейсе (SETTINGS-TO-UI E)

- Переключатели системы/мониторинга переехали из окружения в интерфейс
  настроек: параметры deploy-smoke (enabled, autoRollback, autoUpdate,
  verifyTimeoutSec, tickSec, stepTimeoutSec, healthPollSec, healthTimeoutSec),
  окна здоровья трейсинга (windowSec, healthTtlSec, signalIntervalSec) и
  настройки обслуживания Zabbix (hostGroups, maxWindowSec) зарегистрированы в
  реестре behavior-settings (scope инстанса, раздел `system`) и редактируются
  на Instance → General в новой панели **Система**.
- Потребители читают значения на лету — сервис, индекс и настройки deploy-jobs,
  пробы, проход сигнала и маршруты tracing-health, Zabbix-хуки обслуживания, —
  поэтому изменение в интерфейсе действует без перезапуска. Заданная
  переменная `MYRMIDON_*` остаётся принудительным переопределением; иначе
  действует сохранённое значение, иначе умолчание. API и панель показывают
  источник каждого эффективного значения.
- Новая поверхность только для чтения `GET /api/myrmidon/system/deployment`
  (читать могут доска и агенты, анонимным — 403): сообщает, какие
  инфраструктурные интеграции настроены, — для ссылок на секреты сам факт,
  для URL хост, — но никогда сами значения; показывается блоком
  **Deployment** той же панели.
- Hindsight в реестре не дублируется: остаётся на существующей настройке
  памяти агента с выбором из хранилища секретов.

## settings-en-new

<!-- after: 1.7 — AUTO-UPDATE-SETTINGS B (update window, mode, fleet canary) -->

### 1.7 — SETTINGS-TO-UI E: system and monitoring settings (SystemSettingsPanel)

The system and monitoring toggles that used to be environment-only are now
instance behavior settings (section `system` of the part A registry) edited on
Instance → General in the **System** panel (`SystemSettingsPanel`, subsections
Deploy / Tracing / Monitoring (Zabbix) / Deployment). Each value resolves live
on every read: a set environment variable stays the forced override, otherwise
the saved UI value applies, otherwise the built-in default — a change in the
interface applies without a restart, and the panel and the behavior-settings
API show the source of each effective value (`env`, `ui`, `default`).

Infrastructure values (addresses, sockets, credentials, image digests) are not
behavior settings: they stay environment-only and surface in the read-only
**Deployment** block of the same panel (`GET /api/myrmidon/system/deployment`,
board and agent may read, anonymous callers get 403). It reports only whether
each integration is configured — presence for secret references, the host for
URLs — never the values themselves. The hindsight settings are deliberately
not duplicated here: they stay on the existing agent memory instance setting
(`instance_settings.general.agentMemory`) with live re-read and the
secrets-store picker.

| Setting key | Environment (forced override) | Default | What it does | Bounds / special |
|---|---|---|---|---|
| `system.deploy.enabled` | `MYRMIDON_DEPLOY_ENABLED` | `false` | Allows board deploys from the UI; without it deploy write routes answer 503, reads work | `1`/`true`/`yes`/`on` — enable |
| `system.deploy.autoRollback` | `MYRMIDON_DEPLOY_AUTO_ROLLBACK` | `true` | Health-based automatic rollback of the board after a failed post-deploy health check | `0`/`false`/`no`/`off` — the old contract: `failed_health`, the window stays on for a manual rollback; the host-side `AUTO_ROLLBACK` in deploy.env must agree |
| `system.deploy.autoUpdate` | `MYRMIDON_DEPLOY_AUTO_UPDATE` | `false` | Allows board deploys without a per-deploy confirmation in the interface | Enable only after the release scenario has run on the staging stand (STAND) |
| `system.deploy.verifyTimeoutSec` | `MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC` | `30` | Timeout of network digest checks (registry, GitHub) at job creation and preview | 1–300 |
| `system.deploy.tickSec` | `MYRMIDON_DEPLOY_TICK_SEC` | `5` | How often the job service reconciles state with the maintenance window, the runner report and health | 1–3600 |
| `system.deploy.stepTimeoutSec` | `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` | `1800` | How many seconds a job may stand in one non-terminal status | 10–86400 |
| `system.deploy.healthPollSec` | `MYRMIDON_DEPLOY_HEALTH_POLL_SEC` | `5` | Health-check poll interval of the verification phase | 1–300 |
| `system.deploy.healthTimeoutSec` | `MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC` | `300` | Budget of the health verification phase | 10–3600 |
| `system.tracing.windowSec` | `MYRMIDON_TRACING_WINDOW_SEC` | `900` | Length of the LLM tracing health window | 60–3600 |
| `system.tracing.healthTtlSec` | `MYRMIDON_TRACING_HEALTH_TTL_SEC` | `60` | Cache TTL of the tracing health report | 5–3600 |
| `system.tracing.signalIntervalSec` | `MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC` | `300` | Period of the operator-signal sweep (attention signal + state-transition journal) | 30–86400 |
| `system.zabbix.hostGroups` | `MYRMIDON_ZABBIX_HOST_GROUPS` | `[]` | Zabbix host groups put into maintenance when the instance window is entered (a comma-separated env value or a UI list) | Empty — the integration stays off |
| `system.zabbix.maxWindowSec` | `MYRMIDON_ZABBIX_MAX_WINDOW_SEC` | `14400` | Length of the Zabbix maintenance period; Zabbix closes it itself if the exit never happens | 60–604800 |

The R3/R5-A/R5-C/TRACING-HEALTH rows above keep their environment contracts;
an unset variable now falls back to the saved UI value instead of straight to
the default.

## settings-ru-new

<!-- after: 1.7 — AUTO-UPDATE-SETTINGS B (окно обновления, режим, канарейка парка) -->

### 1.7 — SETTINGS-TO-UI E: системные настройки и мониторинг (SystemSettingsPanel)

Переключатели системы и мониторинга, которые раньше были только переменными окружения, стали настройками поведения инстанса (раздел `system` реестра части A) и редактируются на Instance → General в панели **Система** (`SystemSettingsPanel`, подразделы Deploy / Tracing / Monitoring (Zabbix) / Deployment). Каждое значение разрешается на лету при каждом чтении: заданная переменная окружения остаётся принудительным переопределением, иначе действует сохранённое в интерфейсе значение, иначе встроенное умолчание — изменение в интерфейсе действует без перезапуска, панель и API behavior-settings показывают источник каждого эффективного значения (`env`, `ui`, `default`).

Инфраструктурные значения (адреса, сокеты, учётные данные, digests образов) настройками поведения не являются: они остаются только в окружении и видны в блоке **Deployment** той же панели только для чтения (`GET /api/myrmidon/system/deployment`; читать могут доска и агенты, анонимным — 403). Блок сообщает лишь, настроена ли интеграция, — для ссылок на секреты сам факт, для URL хост, — но никогда сами значения. Настройки hindsight здесь сознательно не дублируются: они остаются на существующей настройке памяти агента (`instance_settings.general.agentMemory`) с чтением на лету и выбором из хранилища секретов.

| Ключ настройки | Переменная (принудительное переопределение) | Умолчание | Что делает | Границы / особое |
|---|---|---|---|---|
| `system.deploy.enabled` | `MYRMIDON_DEPLOY_ENABLED` | `false` | Разрешает выкат доски из интерфейса: без него запись-маршруты выката отвечают 503, чтение работает | `1`/`true`/`yes`/`on` — включить |
| `system.deploy.autoRollback` | `MYRMIDON_DEPLOY_AUTO_ROLLBACK` | `true` | Автоматический откат доски по здоровью при провале проверки здоровья после выката | `0`/`false`/`no`/`off` — старый контракт: `failed_health`, окно остаётся открытым для ручного отката; хостовая сторона `AUTO_ROLLBACK` в deploy.env должна совпадать |
| `system.deploy.autoUpdate` | `MYRMIDON_DEPLOY_AUTO_UPDATE` | `false` | Разрешает выкаты доски без подтверждения в интерфейсе на каждый выкат | Включать только после прогона релизного сценария на стенде (STAND) |
| `system.deploy.verifyTimeoutSec` | `MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC` | `30` | Таймаут сетевых проверок digest (реестр, GitHub) при создании работы и предпросмотре | 1–300 |
| `system.deploy.tickSec` | `MYRMIDON_DEPLOY_TICK_SEC` | `5` | Как часто сервис работ сверяет состояние с окном обслуживания, отчётом исполнителя и здоровьем | 1–3600 |
| `system.deploy.stepTimeoutSec` | `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` | `1800` | Сколько секунд работа может стоять в одном нетерминальном статусе | 10–86400 |
| `system.deploy.healthPollSec` | `MYRMIDON_DEPLOY_HEALTH_POLL_SEC` | `5` | Интервал опроса здоровья в фазе сверки | 1–300 |
| `system.deploy.healthTimeoutSec` | `MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC` | `300` | Бюджет фазы сверки здоровья | 10–3600 |
| `system.tracing.windowSec` | `MYRMIDON_TRACING_WINDOW_SEC` | `900` | Длина окна проверки здоровья LLM-трейсинга | 60–3600 |
| `system.tracing.healthTtlSec` | `MYRMIDON_TRACING_HEALTH_TTL_SEC` | `60` | TTL кеша отчёта о здоровье трейсинга | 5–3600 |
| `system.tracing.signalIntervalSec` | `MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC` | `300` | Период прохода сигнала оператору (сигнал внимания + строка журнала о переходе состояния) | 30–86400 |
| `system.zabbix.hostGroups` | `MYRMIDON_ZABBIX_HOST_GROUPS` | `[]` | Группы хостов Zabbix, переводимые в обслуживание при входе в окно инстанса (через запятую в переменной или списком в интерфейсе) | Пусто — интеграция выключена |
| `system.zabbix.maxWindowSec` | `MYRMIDON_ZABBIX_MAX_WINDOW_SEC` | `14400` | Длина периода обслуживания в Zabbix; если выход не случится, Zabbix закроет период сам | 60–604800 |

Строки R3/R5-A/R5-C/TRACING-HEALTH выше сохраняют свои окруженческие контракты; незаданная переменная теперь откатывается к сохранённому значению интерфейса, а не сразу к умолчанию.
