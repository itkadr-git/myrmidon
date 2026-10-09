---
divergence-section: 1.6 — очереди задач по ролям с leased claims (SWARM-CLAIM, часть A — ядро)
---

## divergence

| 1.6.5-SWARM-SELFORG | Самоорганизация роя — заявленный функционал, пилот снят: ключ настроек `general.swarmClaim` переименован в `general.swarm` (миграция переносит значения), пилотные поля `enabledRoles`/`enabledCompanyIds` и их env `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`/`MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` удалены, пилотный отчёт супервизора и `MYRMIDON_SWARM_PILOT_BASELINE_DOC` удалены. Главный переключатель по умолчанию выключен (design §5.2 — владелец включает осознанно). Пакетные побудки свободных агентов удалены вместе с `MYRMIDON_SWARM_IDLE_WAKE_BATCH`: сопоставление идёт по событиям (завершение прогона, снятие паузы, создание/обновление задачи, истечение аренды), страховочный проход на тике планировщика только подхватывает пропущенное. Автоматический прогон без `issueId` в контексте закрывается `skipped` с кодом `run_without_task` до старта адаптера (0 токенов). Порядок в очереди касты: P0 (critical, при включённом вытеснении) → эффективная сила феромона (сила + старение `agingStep` за `agingStepHours`, потолок `agingCap` − штраф `failPenalty` за пустой неудачный прогон) → возраст в очереди → id задачи. Пустой неудачный прогон (failed/blocked/needs_followup/timed_out без изменений задачи) откладывает следующую попытку на остывание `cooldownBaseMin × 2^(n−1)` минут (потолок `cooldownCapMin`); любое изменение задачи снимает штраф и остывание. Каста задачи решается в три слоя: `issues.caste_key` → каста проекта по умолчанию → каста компании по умолчанию; участие касты в рое — флаг `swarmEligible` справочника каст. Сила феромона задачи — число `issues.pheromone_strength` (0…1000000), стартовое значение — из `pheromone` по приоритету (critical 100 / high 30 / medium 10 / low 1) | Наши файлы: `server/src/myrmidon/swarm-claim/**`, `server/src/myrmidon/castes/**`, `server/src/myrmidon/idle-pickup.ts`, `server/src/myrmidon/wake-task-guard.ts`, `packages/shared/src/myrmidon-swarm-claim.ts`, `packages/shared/src/myrmidon-swarm-wake.ts`, `ui/src/components/myrmidon/SwarmClaimSettingsPanel.tsx` | Вендорский хартбит будит агента «поищи работу» и крутит адаптер вхолостую; доска решает сопоставление сама и будит только с задачей | `server/src/myrmidon/swarm-claim/swarm-claim.myrmidon.test.ts`, `packages/shared/src/myrmidon-swarm-claim.myrmidon.test.ts` | Вернуть вендорский цикл «проснись и поищи»: удалить сопоставление и аренды, вернуть пакетные побудки | #1042 |

## changelog-en

### Swarm self-organization: the board matches tasks to free agents itself (1.6.5-SWARM-SELFORG)

- One switch — **Instance → General → "Self-organisation (swarm)" → "Enabled"** — and the board itself matches every unassigned ready task with a free agent of the right caste and wakes it with that task in hand. Off by default; the pilot role/company lists are gone — the swarm is either on or off.
- Queue order inside a caste: critical (P0) first, then the task's effective pheromone strength (strength + waiting bonus − penalty for failed runs without a task change), then queue age. Tune it in the panel's "Pheromones" block.
- A failed run without a task change cools the task down (30 min, doubling per failed run, capped) — any edit or comment lifts the cooldown at once.
- No more "wake up and look for work" passes: every automatic run starts with a concrete task; a run without one closes as `skipped (run_without_task)` before the adapter starts — zero tokens.
- User guide: [guides/swarm-self-organization.md](../guides/swarm-self-organization.md) (Russian: [swarm-self-organization.ru.md](../guides/swarm-self-organization.ru.md)).

## changelog-ru

### Самоорганизация роя: доска сама сопоставляет задачи со свободными агентами (1.6.5-SWARM-SELFORG)

- Один переключатель — **Instance → General → «Самоорганизация (рой)» → «Включено»** — и доска сама сопоставляет каждую неназначенную готовую задачу со свободным агентом подходящей касты и будит его уже с задачей в руках. По умолчанию выключено; пилотных списков ролей и компаний больше нет — рой либо включён, либо выключен.
- Порядок очереди внутри касты: сначала critical (P0), затем эффективная сила феромона задачи (сила + надбавка за ожидание − штраф за неудачные прогоны без изменений задачи), затем возраст в очереди. Настраивается в блоке «Феромоны» на той же панели.
- Неудачный прогон без изменений задачи отправляет задачу остывать (30 минут, удвоение за каждый следующий прогон, с потолком) — любая правка или комментарий снимают остывание сразу.
- Побудок «проснись и поищи работу» больше нет: каждый автоматический прогон стартует с конкретной задачей; прогон без задачи закрывается как `skipped (run_without_task)` до старта адаптера — токены не тратятся.
- Страница пользователя: [guides/swarm-self-organization.ru.md](../guides/swarm-self-organization.ru.md) (английская: [swarm-self-organization.md](../guides/swarm-self-organization.md)).

## settings-en-new

<!-- after: 1.6 — CTO-CHAT B (the board chat planner: owner text -> proposed epic) -->

### 1.6.5 — Self-organisation (swarm)

Since 1.6.5 the board itself matches every unassigned ready task with a free
agent of the right caste and wakes it with that task in hand. Managed from
**Instance → General → "Self-organisation (swarm)"** — writes
`instance_settings.general.swarm` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
applies without a restart, every change lands in the on-screen journal. The
swarm is **off by default**: turn it on with the "Enabled" switch. The
pre-1.6.5 key `general.swarmClaim` migrates into `general.swarm`; the pilot
fields and variables (`enabledRoles`, `enabledCompanyIds`,
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
`MYRMIDON_SWARM_PILOT_BASELINE_DOC`, `MYRMIDON_SWARM_IDLE_WAKE_BATCH`) are
removed — set values are ignored. User page:
[guides/swarm-self-organization.md](guides/swarm-self-organization.md).

| Field (`general.swarm.*`) | Default | What it does |
|---|---|---|
| `enabled` | off | The swarm master switch: off — no matching at all |
| `leaseTtlSec` | 900 | How long one lease lives without a heartbeat, seconds |
| `maxActiveTasks` | 3 | Ceiling of live leases per agent |
| `sweepIntervalSec` | 30 | How often the safety pass runs, seconds; it only picks up what events missed |
| `p0Preemption` | on | A `critical` task goes first regardless of pheromone strength |
| `pheromone.critical` / `pheromone.high` / `pheromone.medium` / `pheromone.low` | 100 / 30 / 10 / 1 | Pheromone strength a new task of this priority starts with (the task card can set its own number, 0…1000000) |
| `pheromone.agingStepHours` / `pheromone.agingStep` / `pheromone.agingCap` | 24 h / +1 / +5 | Effective strength grows while the task waits, capped at `agingCap` |
| `pheromone.failPenalty` | 10 | Strength subtracted per failed run in a row without a task change; never below zero |
| `pheromone.cooldownBaseMin` / `pheromone.cooldownCapMin` | 30 / 720 | After a failed run without changes the task is not matched for `cooldownBaseMin × 2^(n−1)` minutes, capped at `cooldownCapMin`; any change lifts the cooldown |

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | unset (panel; default off) | Forced override of the swarm master switch | `1`/`true`/`on`/`yes` — force on; `0`/`false`/`off`/`no` — force off. Unset — the UI value applies |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6.5-SWARM | unset (panel; 900) | Override of the lease TTL (sec) | From 60 to 86400. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6.5-SWARM | unset (panel; 3) | Override of the per-agent live-lease ceiling | From 1 to 100; `none`/`0` — no ceiling. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6.5-SWARM | unset (panel; 30) | Override of the safety-pass interval (sec) | From 5. Unset or unreadable — the UI value applies |
| `MYRMIDON_SWARM_CLAIM_P0_PREEMPTION` | 1.6.5-SWARM | unset (panel; on) | Override of the P0 preemption | `1`/`true`/`on`/`yes` — on; `0`/`false`/`off`/`no` — off. Unset — the UI value applies |
| `MYRMIDON_SWARM_SUPERVISOR_TASK_MAX` | 1.6-SWARM-CLAIM-B | `500` | Row cap of queue candidates per caste in the Swarm screen overview; a cap, not a page size | Positive integer from 1 to 5000; anything else — the default (500) |

## settings-ru-new

<!-- after: Настройки в записи агента (не переменные окружения) -->

### 1.6.5 — Самоорганизация (рой)

С 1.6.5 доска сама сопоставляет каждую неназначенную готовую задачу со
свободным агентом подходящей касты и будит его уже с задачей в руках.
Управление — **Instance → General → «Самоорганизация (рой)»** пишет
`instance_settings.general.swarm` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
действует без перезапуска, каждое изменение — в журнале на той же панели.
По умолчанию рой **выключен**: включается переключателем «Включено».
Ключ `general.swarmClaim` миграцией переносится в `general.swarm`; пилотные
поля и переменные (`enabledRoles`, `enabledCompanyIds`,
`MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
`MYRMIDON_SWARM_PILOT_BASELINE_DOC`, `MYRMIDON_SWARM_IDLE_WAKE_BATCH`)
удалены — заданные значения игнорируются. Пользовательская страница:
[guides/swarm-self-organization.ru.md](guides/swarm-self-organization.ru.md).

| Поле (`general.swarm.*`) | По умолчанию | Что делает |
|---|---|---|
| `enabled` | выкл | Главный переключатель роя: выкл — сопоставлений нет |
| `leaseTtlSec` | 900 | Сколько живёт аренда без heartbeat, секунд |
| `maxActiveTasks` | 3 | Потолок живых аренд на агента |
| `sweepIntervalSec` | 30 | Как часто идёт страховочный проход, секунд; он только подхватывает то, что пропустили события |
| `p0Preemption` | вкл | Задача `critical` идёт первой независимо от силы феромона |
| `pheromone.critical` / `pheromone.high` / `pheromone.medium` / `pheromone.low` | 100 / 30 / 10 / 1 | Сила феромона, с которой стартует новая задача этого приоритета (в карточке задачи можно задать своё число, 0…1000000) |
| `pheromone.agingStepHours` / `pheromone.agingStep` / `pheromone.agingCap` | 24 ч / +1 / +5 | Эффективная сила растёт, пока задача ждёт; потолок `agingCap` |
| `pheromone.failPenalty` | 10 | Сила уменьшается за каждый неудачный прогон подряд без изменений задачи; не ниже нуля |
| `pheromone.cooldownBaseMin` / `pheromone.cooldownCapMin` | 30 / 720 | После неудачного прогона без изменений задача не сопоставляется `cooldownBaseMin × 2^(n−1)` минут, с потолком `cooldownCapMin`; любое изменение снимает остывание |

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | не задана (панель; умолчание — выкл) | Принудительное переопределение главного переключателя роя | `1`/`true`/`on`/`yes` — включить; `0`/`false`/`off`/`no` — выключить. Не задана — значение из интерфейса |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6.5-SWARM | не задана (панель; 900) | Переопределение срока аренды (сек) | От 60 до 86400. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6.5-SWARM | не задана (панель; 3) | Переопределение потолка живых аренд на агента | От 1 до 100; `none`/`0` — без потолка. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6.5-SWARM | не задана (панель; 30) | Переопределение интервала страховочного прохода (сек) | От 5. Не задана или нечитаемая — значение из интерфейса |
| `MYRMIDON_SWARM_CLAIM_P0_PREEMPTION` | 1.6.5-SWARM | не задана (панель; вкл) | Переопределение вытеснения P0 | `1`/`true`/`on`/`yes` — вкл; `0`/`false`/`off`/`no` — выкл. Не задана — значение из интерфейса |
| `MYRMIDON_SWARM_SUPERVISOR_TASK_MAX` | 1.6-SWARM-CLAIM-B | `500` | Потолок строк кандидатов очереди на одну касту в обзоре экрана «Рой»; это предел, а не размер страницы | Целое положительное от 1 до 5000; всё прочее — по умолчанию (500) |

## settings-en-replace

<!-- section: 1.6.1 — SWARM-SETTINGS-UI: queues of roles as instance settings -->

| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | unset (panel; default off) | Forced override of the swarm master switch: the swarm is off by default and is turned on in **Instance → General → "Self-organisation (swarm)"** | `1`/`true`/`on`/`yes` — force on; `0`/`false`/`off`/`no` — force off. Unset — the UI value applies |

## settings-en-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.5-SWARM-SELFORG | — | Removed in 1.6.5 with the pilot: who takes part is decided by the caste directory (`swarmEligible` of the caste) | Set values are ignored |

## settings-en-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.5-SWARM-SELFORG | — | Removed in 1.6.5 with the pilot: the swarm is either on or off for the instance, there are no per-company lists | Set values are ignored |

## settings-en-replace

| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.5-SWARM-SELFORG | — | Removed in 1.6.5: the batch wake pass of free agents is gone — matching is event-driven (run finished, pause lifted, task created/updated, lease expired), the safety sweep only picks up what events missed | Set values are ignored |

## settings-en-replace

| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6.5-SWARM-SELFORG | — | Removed in 1.6.5 together with the supervisor pilot report | Set values are ignored |

## settings-ru-replace

<!-- section: 1.6.1 — SWARM-SETTINGS-UI: очереди ролей как настройки инстанса -->

| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6.5-SWARM | не задана (панель; умолчание — выкл) | Принудительное переопределение главного переключателя роя: по умолчанию рой выключен и включается в **Instance → General → «Самоорганизация (рой)»** | `1`/`true`/`on`/`yes` — включить; `0`/`false`/`off`/`no` — выключить. Не задана — значение из интерфейса |

## settings-ru-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.5-SWARM-SELFORG | — | Удалена в 1.6.5 вместе с пилотом: кто участвует в рое, решает справочник каст (флаг `swarmEligible` касты) | Заданные значения игнорируются |

## settings-ru-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.5-SWARM-SELFORG | — | Удалена в 1.6.5 вместе с пилотом: рой либо включён, либо выключен для всего инстанса, списков компаний нет | Заданные значения игнорируются |

## settings-ru-replace

| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.5-SWARM-SELFORG | — | Удалена в 1.6.5: проход «разбудить пачку свободных агентов» убран — сопоставление идёт по событиям (завершение прогона, снятие паузы, создание/обновление задачи, истечение аренды), страховочный проход только подхватывает пропущенное | Заданные значения игнорируются |

## settings-ru-replace

| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6.5-SWARM-SELFORG | — | Удалена в 1.6.5 вместе с пилотным отчётом супервизора | Заданные значения игнорируются |
