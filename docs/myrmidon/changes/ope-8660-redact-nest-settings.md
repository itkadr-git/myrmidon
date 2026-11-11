## changelog-en

### 1.7 REDACT: per-nest redaction dictionaries and rules (OPE-8660)

- Knowledge modules now redact per nest: a counterparty/signer dictionary
  (source text → replacement), toggleable rules (`counterparties`, `signers`,
  `contracts`, `invoices`) and a default mode (`redact`/`disabled`) are stored
  one row per `nest_id` in the `nest_redact_settings` table (migration
  `0480_equal_sharon_carter`).
- The settings are managed with `GET`/`PATCH /api/myrmidon/nests/:nestId/redact`
  (`PATCH` is instance-admin only; `GET` also serves board-org actors scoped to
  their companies) and are read on every create/draft knowledge request — an
  update applies without a server restart. A nest without a stored row uses the
  safe default configuration.

## changelog-ru

### 1.7 REDACT: словари контрагентов/подписантов и правила редактирования по гнезду (OPE-8660)

- Модуль знаний редактирует (REDACT) текст по настройкам гнезда: словарь
  контрагентов и подписантов (исходная строка → замена), включаемые правила
  (`counterparties`, `signers`, `contracts`, `invoices`) и режим по умолчанию
  (`redact`/`disabled`) хранятся по строке на `nest_id` в таблице
  `nest_redact_settings` (миграция `0480_equal_sharon_carter`).
- Настройки управляются маршрутами `GET`/`PATCH /api/myrmidon/nests/:nestId/redact`
  (`PATCH` — только администратор экземпляра; `GET` доступен и board-актёрам в
  пределах их компаний) и читаются на каждый запрос создания/черновика знания —
  изменение применяется без перезапуска сервера. Гнездо без сохранённой строки
  работает с безопасной конфигурацией по умолчанию.

## divergence-new

<!-- after: 1.6.6 — SKILLS-UI A: обнаружение agentskills.io и импорт архивов по дайджесту (сервер) -->

### 1.7 — REDACT: словари контрагентов/подписантов и правила редактирования по гнезду (OPE-8660)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-REDACT | Настройка редактирования (REDACT) по гнезду: словарь названий контрагентов/подписантов, включаемые правила (counterparties/signers/contracts/invoices) и режим по умолчанию на гнездо; хранение в БД (`nest_redact_settings`), управление `GET/PATCH /api/myrmidon/nests/:nestId/redact`, применение при create/draft знаний без перезапуска. | Вендор: `packages/shared/src/index.ts` (реэкспорт `myrmidon-redact`), `packages/db/src/schema/index.ts` (экспорт `nestRedactSettings`), `server/src/myrmidon/knowledge/service.ts` (редактирование на create/draft). Наши файлы: `+ packages/shared/src/myrmidon-redact.ts`, `+ packages/db/src/schema/nest_redact_settings.ts`, `+ server/src/myrmidon/redact/{index,routes,service,store}.ts`, `+ packages/db/src/migrations/0480_equal_sharon_carter.sql`. | Правила гнезда применяются к запросу с `nest_id`, словарь гнезда ловит контрагента (OPE-8660). | `packages/shared/src/myrmidon-redact.test.ts`, `server/src/__tests__/redaction.test.ts`, `server/src/myrmidon/knowledge/knowledge-store.db.myrmidon.test.ts` | Никогда, наше поведение. При переносе: удалить куски с меткой `myrmidon(1.7 REDACT)` и строки barrel-экспортов | OPE-8660 |

## settings-en-new

<!-- after: 1.6.6 — ALERTS: monitoring alerts webhook (Zabbix + Alertmanager) -->

### 1.7 — REDACT: per-nest redaction dictionaries and rules (OPE-8660)

Per-nest redaction settings of `server/src/myrmidon/redact/` (the 1.7 REDACT
track, OPE-8660). Stored in the `nest_redact_settings` database table (one row
per `nest_id`, the current nest identity is `companies.id`) and read on every
knowledge create/draft request — updates apply without a restart. Managed with
`GET`/`PATCH /api/myrmidon/nests/:nestId/redact`; unknown nest — the safe
default configuration.

| Setting | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `GET`/`PATCH /api/myrmidon/nests/:nestId/redact` (route) | 1.7-REDACT | default config | Per-nest redaction settings stored in the `nest_redact_settings` table (one row per `nest_id`, current identity `companies.id`) and read on each request — no restart: `mode` (`redact`/`disabled`), enabled rules (`counterparties`, `signers`, `contracts`, `invoices`), counterparty/signer dictionaries (source → replacement) and contract/invoice number lists. `PATCH` is instance-admin only; `GET` also serves board-org actors scoped to their companies; unknown nest — the safe default config | DELETE the row or `mode: "disabled"` — redaction is off for that nest |

## settings-ru-new

<!-- after: 1.6.6 — ALERTS: вебхук мониторинговых тревог (Zabbix + Alertmanager) -->

### 1.7 — REDACT: словари и правила редактирования по гнезду (OPE-8660)

Настройки REDACT по гнезду в `server/src/myrmidon/redact/` (трек 1.7 REDACT,
OPE-8660). Хранятся в таблице БД `nest_redact_settings` (строка на `nest_id`,
текущая идентичность гнезда — `companies.id`) и читаются на каждый запрос
создания/черновика знания — изменения применяются без перезапуска. Управление —
`GET`/`PATCH /api/myrmidon/nests/:nestId/redact`; неизвестное гнездо —
безопасная конфигурация по умолчанию.

| Настройка | Фича | Умолчание | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `GET`/`PATCH /api/myrmidon/nests/:nestId/redact` (маршрут) | 1.7-REDACT | конфигурация по умолчанию | Настройка редактирования (REDACT) по гнезду: хранится в таблице `nest_redact_settings` (строка на `nest_id`, текущая идентичность — `companies.id`) и читается на каждый запрос — без перезапуска: `mode` (`redact`/`disabled`), включаемые правила (`counterparties`, `signers`, `contracts`, `invoices`), словари контрагентов и подписантов (исходная строка → замена) и списки номеров договоров/счетов. `PATCH` — только администратор экземпляра; `GET` доступен и board-актёрам в пределах их компаний; неизвестное гнездо — безопасная конфигурация по умолчанию | Удалить строку или `mode: "disabled"` — редактирование для гнезда выключено |
