## changelog-en

### Fleet dashboard data from VictoriaMetrics + Zabbix (1.6.6 MONITORING C)

- `GET /api/myrmidon/monitoring/dashboard` aggregates one fleet snapshot:
  host cards (CPU / memory / swap / disk percent) from VictoriaMetrics
  (node_exporter PromQL, VM wins per host) merged with Zabbix `host.get` /
  `item.get` readings, bot container usage (cAdvisor), the LiteLLM proxy
  rollup and the build-VPS rollup; every host card carries a `runbookKey`
  for the "create task with runbook" CTA of the fleet screen.
- Connection settings live under `GET/PATCH /api/myrmidon/monitoring`
  (instance-settings pattern): VM / Zabbix addresses, `env:`/`file:` token
  references and the VM job selector. Secret values are never returned and
  never logged; both sources are read-only (instant queries, `apiinfo.version`,
  `host.get`, `item.get` — no writes).
- `GET /api/myrmidon/monitoring/dashboard/selfcheck` probes every configured
  source and answers `{ok, vm_ok, zabbix_ok, sources:[{name, ok, latency_ms}]}`
  without any secret material.

## changelog-ru

### Данные дашборда флота из VictoriaMetrics + Zabbix (1.6.6 MONITORING C)

- `GET /api/myrmidon/monitoring/dashboard` отдаёт один снимок флота:
  карточки хостов (CPU / память / swap / диск) из VictoriaMetrics
  (PromQL node_exporter, приоритет VM) в слиянии с показаниями Zabbix
  `host.get` / `item.get`, контейнеры ботов (cAdvisor), сводка LiteLLM и
  сборочного VPS; у каждой карточки — `runbookKey` для действия «создать
  задачу с runbook» на экране флота.
- Настройки подключений — `GET/PATCH /api/myrmidon/monitoring`
  (instance-settings): адреса VM / Zabbix, ссылки на токены `env:`/`file:`,
  селектор job для VM. Значения секретов не возвращаются и не логируются;
  оба источника — только чтение (instant query, `apiinfo.version`,
  `host.get`, `item.get`; записей нет).
- `GET /api/myrmidon/monitoring/dashboard/selfcheck` проверяет каждый
  настроенный источник и отвечает
  `{ok, vm_ok, zabbix_ok, sources:[{name, ok, latency_ms}]}` без секретов.

## divergence-new

<!-- after: 1.6.6 — вебхук тревог мониторинга (ALERTS) -->

### 1.6.6 — данные дашборда флота из VictoriaMetrics + Zabbix (MONITORING C)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6 MONITORING C | API дашборда флота `GET /api/myrmidon/monitoring/dashboard`: карточки хостов (CPU/память/swap/диск) из VictoriaMetrics (PromQL node_exporter, приоритет VM) в слиянии с Zabbix `host.get`/`item.get`, контейнеры ботов (cAdvisor), сводка LiteLLM и сборочного VPS; у каждой карточки `runbookKey` для CTA «создать задачу с runbook». Настройки подключений `GET/PATCH /api/myrmidon/monitoring` (instance-settings, ключ `myrmidonMonitoringDashboard`): адреса VM/Zabbix, ссылки на токены `env:`/`file:`, селектор job; значения секретов не возвращаются и не логируются. Самопроверка `GET /api/myrmidon/monitoring/dashboard/selfcheck` → `{ok, vm_ok, zabbix_ok, sources:[{name, ok, latency_ms}]}` без секретов. Источники только на чтение: VM `/api/v1/query`, Zabbix `apiinfo.version`/`host.get`/`item.get` — записей нет | `server/src/app.ts` (импорт + одна строка монтирования с меткой `myrmidon(1.6.6 MONITORING C)`) + наши файлы `server/src/myrmidon/monitoring/dashboard/{domain,service,settings,token,vm,zabbix,routes,index}.ts` | Дашборд флота 1.6.6 MONITORING: видеть загрузку vm-core и сборочного VPS до UI-экрана OPE-3918; основа самовосстановления роя | `server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts`, `dashboard.myrmidon.test.ts` | Никогда, наше поведение: вендор не собирает дашборд внешнего флота. Снять целиком: удалить метки `myrmidon(1.6.6 MONITORING C)` в app.ts, модуль и тесты | (этот PR) |

## settings-en-new

<!-- after: 1.6.1 — VOICE-STT (server-side speech-to-text core, part A) -->

### 1.6.6 — MONITORING C: fleet dashboard connections (VictoriaMetrics + Zabbix)

Settings of `server/src/myrmidon/monitoring/dashboard/` — connection
settings of the fleet dashboard, stored in `instance_settings.general` under
the key `myrmidonMonitoringDashboard` (per company). Read and patched through
`GET/PATCH /api/myrmidon/monitoring`. Token values are never stored here —
only `env:<NAME>` / `file:<PATH>` references, resolved per request (the
maintenance/zabbix pattern) and never returned or logged. Both sources are
read-only: the VM client issues instant PromQL queries, the Zabbix client
calls `apiinfo.version` / `host.get` / `item.get` only.

| Variable | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `myrmidonMonitoringDashboard.vmUrl` | 1.6.6 MONITORING C | unset | Base URL of VictoriaMetrics (e.g. `http://vm:8428`); the dashboard reads host / container / LiteLLM metrics from it | Unset — the VM source reports `not_configured` |
| `myrmidonMonitoringDashboard.vmTokenRef` | 1.6.6 MONITORING C | unset | Optional read-token reference for VM: `env:<NAME>` or `file:<PATH>`; the value is resolved per request and never logged or returned | Unset — VM queried without auth |
| `myrmidonMonitoringDashboard.zabbixUrl` | 1.6.6 MONITORING C | unset | Zabbix API endpoint (api_jsonrpc.php); host readings come from `host.get` / `item.get` | Unset — the Zabbix source reports `not_configured` |
| `myrmidonMonitoringDashboard.zabbixTokenRef` | 1.6.6 MONITORING C | unset | Read-token reference for the Zabbix API (`env:`/`file:`); value never returned | Unset — Zabbix queried without auth |
| `myrmidonMonitoringDashboard.vmJobSelector` | 1.6.6 MONITORING C | `node` | PromQL label value selecting the fleet node_exporter jobs (`job=~"..."`) | — |
| `myrmidonMonitoringDashboard.zabbixHostGroups` | 1.6.6 MONITORING C | `[]` | Zabbix host groups the dashboard reads; empty = all monitored hosts | — |
| `myrmidonMonitoringDashboard.timeoutMs` | 1.6.6 MONITORING C | `10000` | Per-source request timeout (500–60000 ms) | — |

## settings-ru-new

<!-- after: 1.6.1 — VOICE-STT (серверное ядро распознавания речи, часть A) -->

### 1.6.6 — MONITORING C: подключения дашборда флота (VictoriaMetrics + Zabbix)

Настройки `server/src/myrmidon/monitoring/dashboard/` — подключения дашборда
флота, в `instance_settings.general` под ключом `myrmidonMonitoringDashboard`
(на компанию). Читаются и меняются через `GET/PATCH /api/myrmidon/monitoring`.
Значения токенов здесь не хранятся — только ссылки `env:<ИМЯ>` /
`file:<ПУТЬ>`, разрешаемые на каждый запрос (паттерн maintenance/zabbix) и
никогда не возвращаемые и не логируемые. Оба источника — только чтение:
VM-клиент делает instant PromQL-запросы, Zabbix-клиент вызывает только
`apiinfo.version` / `host.get` / `item.get`.

| Переменная | Фича | Умолчание | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `myrmidonMonitoringDashboard.vmUrl` | 1.6.6 MONITORING C | не задано | Базовый URL VictoriaMetrics (например `http://vm:8428`); дашборд читает метрики хостов / контейнеров / LiteLLM | Не задано — источник VM отвечает `not_configured` |
| `myrmidonMonitoringDashboard.vmTokenRef` | 1.6.6 MONITORING C | не задано | Ссылка на read-токен VM: `env:<ИМЯ>` или `file:<ПУТЬ>`; значение разрешается на запрос и не логируется | Не задано — VM без авторизации |
| `myrmidonMonitoringDashboard.zabbixUrl` | 1.6.6 MONITORING C | не задано | Endpoint Zabbix API (api_jsonrpc.php); показания хостов из `host.get` / `item.get` | Не задано — источник Zabbix отвечает `not_configured` |
| `myrmidonMonitoringDashboard.zabbixTokenRef` | 1.6.6 MONITORING C | не задано | Ссылка на read-токен Zabbix API (`env:`/`file:`); значение не возвращается | Не задано — Zabbix без авторизации |
| `myrmidonMonitoringDashboard.vmJobSelector` | 1.6.6 MONITORING C | `node` | Значение метки job для node_exporter флота (`job=~"..."`) | — |
| `myrmidonMonitoringDashboard.zabbixHostGroups` | 1.6.6 MONITORING C | `[]` | Группы хостов Zabbix для чтения; пусто = все наблюдаемые | — |
| `myrmidonMonitoringDashboard.timeoutMs` | 1.6.6 MONITORING C | `10000` | Таймаут запроса к источнику (500–60000 мс) | — |
