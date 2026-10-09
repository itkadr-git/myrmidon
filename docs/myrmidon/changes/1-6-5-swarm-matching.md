---
divergence-section: 1.6.5 — SWARM-SELFORG: доска сама сопоставляет задачу со свободным агентом по запаху
---

## divergence

| 1.6.5-SWARM-SELFORG | Самоорганизация роя — заявленный функционал, а не пилот: ключ настроек `general.swarmClaim` переименован в `general.swarm` (миграция переносит значения, пилотные поля `enabledRoles`/`enabledCompanyIds` не переносятся и удалены вместе с env `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`/`MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`), умолчание главного переключателя — включено. Проход пакетных побудок свободных агентов удалён вместе с `MYRMIDON_SWARM_IDLE_WAKE_BATCH`: сопоставление идёт по событиям (завершение прогона, снятие паузы, создание/обновление задачи, истечение аренды), страховочный проход на тике планировщика только подхватывает пропущенное. Автоматический прогон без `issueId` в контексте закрывается `skipped` с кодом `run_without_task` до старта адаптера (0 токенов). Порядок в очереди касты — по эффективной силе феромона: база из приоритета (`pheromoneDefaults`: critical 100 / high 30 / medium 10 / low 1) плюс накопление ожидания (`agingStep` за `agingStepHours`, потолок `agingCap`) минус испарение (`failPenalty` за каждый неудачный прогон подряд без изменений задачи, не ниже нуля); `critical` идёт первым при включённом вытеснении P0. После неудачного прогона без изменений задача остывает (`cooldownBaseMin × 2^(n−1)` минут, потолок 24 ч) — любое изменение задачи снимает остывание и штраф. Гейт простаивания учитывает остывание. Выбор агента внутри касты — по запаху (`scent.tagWeight`, `scent.tierFit`, `scent.seriousThreshold`, `scent.consequencesBonus`), с гнёздами проектов и кастовым потолком активных задач. Побудка назначения — `swarm_matched` с привязкой к задаче. Пилотный отчёт супервизора удалён (`MYRMIDON_SWARM_PILOT_BASELINE_DOC` игнорируется); экран «Рой» показывает очередь каст с эффективной силой, раздел «Остывание» и предупреждения (задачи без агентов касты, задачи в остывании, прогоны без задачи за сутки) | Наши файлы: `server/src/myrmidon/swarm-claim/**`, `packages/shared/src/myrmidon-swarm-claim.ts`, `ui/src/components/myrmidon/SwarmClaimSettingsPanel.tsx`; в вендоре помечены `myrmidon(SWARM-SELFORG)`: `server/src/services/heartbeat.ts` (точки допуска побудок), `server/src/index.ts` (страховочный проход), `packages/shared/src/validators/instance.ts` (ключ `general.swarm`), `docs/myrmidon/SETTINGS.md` (своя секция) | Вендорской самоорганизации нет: побудки идут только на назначение, комментарий и таймер, а агент без задачи в контексте запускает прогон и не может писать в задачу (403) | `server/src/myrmidon/swarm-claim/swarm-claim.myrmidon.test.ts`, `server/src/__tests__/swarm-idle-claim-embedded.myrmidon.test.ts`, `packages/shared/src/myrmidon-swarm-claim.myrmidon.test.ts` | Никогда, наше поведение. Удаляется вместе с эпиком: удалить модуль, снять строки с меткой `myrmidon(SWARM-SELFORG)` | (этот PR) |

## settings-en-new

<!-- after: 1.6 — CTO-CHAT B (the board chat planner: owner text -> proposed epic) -->

### 1.6.5 — Self-organization (swarm)

Since 1.6.5 the swarm is a shipped feature, not a pilot: the board itself
matches every unassigned ready task with a free agent of the right caste and
wakes it with that task in hand (wake reason `swarm_matched`). Managed from
Instance → General → "Self-organization (swarm)" — writes
`instance_settings.general.swarm` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
applies without a restart, every change lands in the on-screen journal. The
pre-1.6.5 key `general.swarmClaim` migrates into `general.swarm`; the pilot
fields and variables (`enabledRoles`, `enabledCompanyIds`,
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
`MYRMIDON_SWARM_PILOT_BASELINE_DOC`, `MYRMIDON_SWARM_IDLE_WAKE_BATCH`) are
removed — set values are ignored. User page:
[guides/swarm-self-organization.md](guides/swarm-self-organization.md).

| Field (`general.swarm.*`) | Default | What it does |
|---|---|---|
| `enabled` | on | The swarm master switch: off — no matching, live leases released at once |
| `pheromoneDefaults` | critical 100 / high 30 / medium 10 / low 1 | Pheromone strength of a task when the task card does not set it |
| `agingStepHours` / `agingStep` / `agingCap` | 24 h / +1 / +5 | Effective strength grows while the task waits, capped at `agingCap` |
| `failPenalty` | 10 | Strength drops per failed run in a row without a task change; never below zero |
| `cooldownBaseMin` (cap 24 h) | 30 min | A task after a failed run without changes is not matched for `cooldownBaseMin × 2^(n−1)` minutes; any change lifts the cooldown |
| `p0Preemption` | on | A `critical` task goes first regardless of strength |
| `leaseTtlSec` / `maxActiveTasks` / `sweepIntervalSec` | 900 / 3 / 30 | Lease TTL, per-agent ceiling of live leases, safety-pass interval |
| `scent.*` (`tagWeight`, `tierFit`, `seriousThreshold`, `consequencesBonus`) | 10 / 20 / 0.4 / +10 | Agent-pick weights inside a caste |

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | unset (panel; default on) | Forced override of the swarm master switch | `1`/`true`/`on`/`yes` — force on; `0`/`false`/`off`/`no` — force off (leases released). Unset — the UI value applies |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6.5-SWARM | unset (panel; 900) | Override of the lease TTL (sec) | From 60 to 86400. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6.5-SWARM | unset (panel; 3) | Override of the per-agent live-lease ceiling | From 1 to 100; `none`/`0` — no ceiling. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6.5-SWARM | unset (panel; 30) | Override of the safety-pass interval (sec) | From 5. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_CLAIM_P0_PREEMPTION` | 1.6.5-SWARM | unset (panel; on) | Override of the P0 preemption | `1`/`true`/`on`/`yes` — on; `0`/`false`/`off`/`no` — off. Unset — the UI value applies |
| `MYRMIDON_SWARM_SUPERVISOR_TASK_MAX` | 1.6-SWARM-CLAIM-B | `500` | Row cap of queue candidates per caste in the Swarm screen overview; a cap, not a page size | Positive integer from 1 to 5000; anything else — the default (500) |

## settings-ru-new

<!-- after: 1.6 — CTO-CHAT B (планировщик чата доски: текст владельца -> предлагаемый эпик) -->

### 1.6.5 — Самоорганизация (рой)

С 1.6.5 рой — заявленный функционал, а не пилот: доска сама сопоставляет
каждую неназначенную готовую задачу со свободным агентом подходящей касты и
будит его уже с задачей в руках (причина побудки `swarm_matched`).
Управление — Instance → General → «Самоорганизация (рой)» пишет
`instance_settings.general.swarm` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
действует без перезапуска, каждое изменение — в журнале на той же панели.
Ключ `general.swarmClaim` миграцией переносится в `general.swarm`; пилотные
поля и переменные (`enabledRoles`, `enabledCompanyIds`,
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
`MYRMIDON_SWARM_PILOT_BASELINE_DOC`, `MYRMIDON_SWARM_IDLE_WAKE_BATCH`)
удалены — заданные значения игнорируются. Пользовательская страница:
[guides/swarm-self-organization.ru.md](guides/swarm-self-organization.ru.md).

| Поле (`general.swarm.*`) | По умолчанию | Что делает |
|---|---|---|
| `enabled` | вкл | Главный переключатель роя: выкл — сопоставлений нет, живые аренды отпускаются сразу |
| `pheromoneDefaults` | critical 100 / high 30 / medium 10 / low 1 | Сила феромона задачи, если она не задана явно |
| `agingStepHours` / `agingStep` / `agingCap` | 24 ч / +1 / +5 | Эффективная сила растёт, пока задача ждёт; потолок `agingCap` |
| `failPenalty` | 10 | Сила уменьшается за каждый неудачный прогон подряд без изменений задачи; не ниже нуля |
| `cooldownBaseMin` (потолок 24 ч) | 30 мин | Задача после неудачного прогона без изменений не сопоставляется `cooldownBaseMin × 2^(n−1)` минут; любое изменение снимает остывание |
| `p0Preemption` | вкл | Задача `critical` идёт первой независимо от силы |
| `leaseTtlSec` / `maxActiveTasks` / `sweepIntervalSec` | 900 / 3 / 30 | Срок аренды, потолок живых аренд на агента, интервал страховочного прохода |
| `scent.*` (`tagWeight`, `tierFit`, `seriousThreshold`, `consequencesBonus`) | 10 / 20 / 0.4 / +10 | Веса выбора агента внутри касты |

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | не задана (панель; умолчание — вкл) | Принудительное переопределение главного переключателя роя | `1`/`true`/`on`/`yes` — включить; `0`/`false`/`off`/`no` — выключить (аренды отпускаются). Не задана — значение из интерфейса |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6.5-SWARM | не задана (панель; 900) | Переопределение срока аренды (сек) | От 60 до 86400. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6.5-SWARM | не задана (панель; 3) | Переопределение потолка живых аренд на агента | От 1 до 100; `none`/`0` — без потолка. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6.5-SWARM | не задана (панель; 30) | Переопределение интервала страховочного прохода (сек) | От 5. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_CLAIM_P0_PREEMPTION` | 1.6.5-SWARM | не задана (панель; вкл) | Переопределение вытеснения P0 | `1`/`true`/`on`/`yes` — вкл; `0`/`false`/`off`/`no` — выкл. Не задана — значение из интерфейса |
| `MYRMIDON_SWARM_SUPERVISOR_TASK_MAX` | 1.6-SWARM-CLAIM-B | `500` | Потолок строк кандидатов очереди на одну касту в обзоре экрана «Рой»; это предел, а не размер страницы | Целое положительное от 1 до 5000; всё прочее — по умолчанию (500) |
