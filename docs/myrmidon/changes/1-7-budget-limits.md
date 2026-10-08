## changelog-en

### Spend limits per hierarchy level, API and change journal (1.7-BUDGET-CONFIG-A)

- The board stores spend limits per hierarchy level — nest (company/project), caste (role),
  foraging, issue — one row per `(company, level, ref)` with `amountCents`, `period`
  (`calendar_month_utc`/`lifetime`), `mode` (`hard` refuses, `soft` pauses with a card to the
  owner) and `is_active`. Full change journal (`budget_limit_changes`): every create/update/delete
  with before/after snapshots and the actor.
- API under `/api/myrmidon/companies/:companyId/budget-limits`: CRUD on limits (mutations are
  board-only, each mutation writes a journal row and an activity-log entry), the journal (newest
  first, filterable by level), `usage` — the "spent in period" of every limit computed from
  `litellm_cost_events` per level (foraging reads the FORAGING sweep budget state, absorbing
  OPE-3964) with an `overLimit` flag.
- The global "signal only" mode (`instance_settings.general.budgetLimits.signalOnly`) is ON by
  default: limits never stop work until the owner explicitly turns it off. Runtime-mutable via
  `GET/PATCH …/budget-limits/signal-only`; the env variable `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY`
  is a forced override only, and the GET reports the effective value's source
  (`stored`/`default`/`env`).
- DB: tables `budget_limits` and `budget_limit_changes` (migration 0312, additive only). See
  [guides/budget-limits.md](guides/budget-limits.md).

## changelog-ru

### Лимиты расхода по уровням иерархии, API и журнал изменений (1.7-BUDGET-CONFIG-A)

- Доска хранит лимиты расхода по уровням иерархии — гнездо (компания/проект), каста (роль),
  фуражировка, задача — одна строка на `(company, level, ref)` с полями `amountCents`, `period`
  (`calendar_month_utc`/`lifetime`), `mode` (`hard` отказывает, `soft` ставит на паузу с карточкой
  владельцу) и `is_active`. Полный журнал изменений (`budget_limit_changes`): каждый
  create/update/delete со снапшотами before/after и автором.
- API под `/api/myrmidon/companies/:companyId/budget-limits`: CRUD лимитов (мутации — только
  board, каждая пишет строку журнала и запись activity log), журнал (новые сверху, фильтр по
  уровню), `usage` — «израсходовано за период» каждого лимита из `litellm_cost_events` по уровню
  (foraging читает бюджетное состояние свипа FORAGING, поглощает OPE-3964) с флагом `overLimit`.
- Глобальный режим «только сигнал» (`instance_settings.general.budgetLimits.signalOnly`) по
  умолчанию ВКЛЮЧЁН: лимиты не останавливают работу, пока владелец явно его не выключит.
  Меняется на лету через `GET/PATCH …/budget-limits/signal-only`; env
  `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` — только принудительное переопределение, GET отдаёт
  источник действующего значения (`stored`/`default`/`env`).
- БД: таблицы `budget_limits` и `budget_limit_changes` (миграция 0312, аддитивная). См.
  [guides/budget-limits.ru.md](guides/budget-limits.ru.md).

## divergence-new

<!-- after: 1.7 — BUDGET-CONFIG B: исполнение лимитов — сигнал / мягкий / жёсткий -->

### 1.7 — BUDGET-CONFIG A: лимиты расхода по уровням иерархии, API и журнал изменений

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-BUDGET-CONFIG-A | Лимиты расхода хранятся в доске по уровням иерархии — гнездо (компания/проект), каста (роль), фуражировка, задача — и меняются через API с журналом «кто, когда, что». Миграция `0312` (аддитивная): таблица `budget_limits` (одна строка на `(company, level, ref)`: amount_cents, period `calendar_month_utc`/`lifetime`, mode `hard`/`soft`, is_active) и таблица журнала `budget_limit_changes` (create/update/delete со снапшотами before/after, actorType/actorId, at). API: `GET/PUT/DELETE …/budget-limits/limits/:level/:ref` (чтение — участники компании, мутации — board, каждая с journal-строкой и записью activity log), `GET …/budget-limits`, `GET …/budget-limits/journal` (новые сверху, можно по уровню), `GET …/budget-limits/usage` — «израсходовано за период» каждого лимита из существующего учёта (`litellm_cost_events`: nest-company — все события компании, nest-проект — события задач проекта, каста — события агентов роли, задача — события issueId; foraging — бюджетное состояние свипа FORAGING, уровень поглощает OPE-3964), с флагом overLimit. Глобальный режим «только сигнал» — `instance_settings.general.budgetLimits` (`{ signalOnly }`, по умолчанию ВКЛЮЧЁН: лимиты не останавливают работу, пока владелец явно не выключит), runtime-мутабельный через `GET/PATCH …/budget-limits/signal-only`; env `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` — только принудительное переопределение, источник значения (stored/default/env) отдаётся в GET | Наши файлы: `server/src/myrmidon/budget-limits/{index,settings,store,usage,foraging-port,routes}.ts`, `packages/db/src/schema/myrmidon_budget_limits.ts`, миграция `0312_budget_limits.sql` (+ meta journal/snapshot), `packages/shared/src/myrmidon-budget-limits.ts` (+ экспорт в `packages/shared/src/index.ts`), тесты; в вендоре помечены `myrmidon(1.7-BUDGET-CONFIG A)`: `server/src/app.ts` (импорт + `api.use`), `server/src/services/instance-settings.ts` (import + preserve-строка ключа `budgetLimits`), `packages/db/src/schema/index.ts` (экспорт таблиц), `packages/shared/src/{types,validators}/instance.ts` (поле `budgetLimits` в general-схеме), фрагмент `docs/myrmidon/changes/1-7-budget-limits.md` | Эпик 1.7 BUDGET-CONFIG (часть A, OPE-4161): лимиты расхода должны настраиваться в оркестраторе по иерархии гнездо → каста → фуражировка → тикет и меняться через API с журналом изменений; вендорские budget_policies знают только скоупы company/agent/project и не имеют иерархии и журнала | `server/src/myrmidon/budget-limits/budget-limits.db.myrmidon.test.ts` (приёмка: лимит касты создаётся/читается/меняется, каждое изменение в журнале с before/after; израсходованное по уровню совпадает с суммой расхода задач уровня на фикстурах; один-на-тройку, компании раздельны), `routes.myrmidon.test.ts` (доступ: чужая компания 403, мутации только board, 400 на неизвестный уровень/битый ref/отрицательную сумму), `packages/shared/src/myrmidon-budget-limits.myrmidon.test.ts` (разрешение signal-only: default/stored/env, опечатка env не меняет выбор; окна периода; строгий overLimit) | Никогда, наше поведение. Если вендор заведёт свою иерархию лимитов с журналом — сверить уровни и убрать модуль, таблицы и ключ general; миграция не снимается — таблицы остаются | (этот PR) |

## settings-en-new

<!-- after: 1.7 — BUDGET-CONFIG B: enforcement mode of spend limits -->

### 1.7 — Spend limits per hierarchy level (BUDGET-CONFIG A)

Settings of `server/src/myrmidon/budget-limits/` (the 1.7 BUDGET-CONFIG epic,
part A). Limits live in `budget_limits` (migration 0312, additive: one row per
`(company, level, ref)` with `amount_cents`, `period` `calendar_month_utc` or
`lifetime`, mode `hard`/`soft`, `is_active`) with the change journal
`budget_limit_changes`; they are managed through
`/api/myrmidon/companies/:companyId/budget-limits` (CRUD is board-only, every
mutation writes a journal row). The global "signal only" mode is stored in
`instance_settings.general.budgetLimits` (`{ signalOnly }`, ON by default via
`preserveBudgetLimitsGeneralKey`) and changed at runtime through
`GET/PATCH …/budget-limits/signal-only` without a restart; `usage` answers the
spent-in-period of every limit from `litellm_cost_events` with an `overLimit`
flag. See the guide [guides/budget-limits.md](guides/budget-limits.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` | BUDGET-CONFIG A | unset | **Forced override** of the global "signal only" mode. `1`/`true`/`yes`/`on` — limits never stop work; `0`/`false`/`no`/`off` — the stored mode applies as enforcement | Unset — the stored value of `instance_settings.general.budgetLimits.signalOnly` applies (ON by default); any other value is ignored, so a typo never flips the owner's choice. GET `…/budget-limits/signal-only` reports the effective value with its source (`stored`, `default`, `env`) |

## settings-ru-new

<!-- after: 1.7 — BUDGET-CONFIG B: режим исполнения лимитов расхода -->

### 1.7 — Лимиты расхода по уровням иерархии (BUDGET-CONFIG A)

Настройки `server/src/myrmidon/budget-limits/` (эпик 1.7 BUDGET-CONFIG, часть A).
Лимиты лежат в `budget_limits` (миграция 0312, аддитивная: строка на
`(company, level, ref)` с `amount_cents`, период `calendar_month_utc` или
`lifetime`, режим `hard`/`soft`, `is_active`) с журналом изменений
`budget_limit_changes`; управляются через
`/api/myrmidon/companies/:companyId/budget-limits` (мутации — только board,
каждая пишет строку журнала). Глобальный режим «только сигнал» хранится в
`instance_settings.general.budgetLimits` (`{ signalOnly }`, по умолчанию
ВКЛЮЧЁН, переживает вендорские записи `general` через
`preserveBudgetLimitsGeneralKey`) и меняется на лету через
`GET/PATCH …/budget-limits/signal-only` без перезапуска; `usage` отдаёт
«израсходовано за период» каждого лимита из `litellm_cost_events` с флагом
`overLimit`. См. гайд [guides/budget-limits.ru.md](guides/budget-limits.ru.md).

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенность |
|---|---|---|---|---|
| `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` | BUDGET-CONFIG A | unset | **Принудительное переопределение** глобального режима «только сигнал». `1`/`true`/`yes`/`on` — лимиты не останавливают работу; `0`/`false`/`no`/`off` — действует сохранённый режим как блокировка | Unset — действует сохранённое значение `instance_settings.general.budgetLimits.signalOnly` (по умолчанию включён); любое другое значение игнорируется, опечатка не меняет выбор владельца. GET `…/budget-limits/signal-only` показывает действующее значение и его источник (`stored`, `default`, `env`) |
