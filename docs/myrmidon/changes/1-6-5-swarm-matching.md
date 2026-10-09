---
divergence-section: 1.6 — очереди задач по ролям с leased claims (SWARM-CLAIM, часть A — ядро)
---

## divergence

| 1.6.5-SWARM-SELFORG | Самоорганизация роя — заявленный функционал: главный переключатель по умолчанию выключен (design §5.2 — владелец включает осознанно), списки ролей и компаний убраны, рой либо включён, либо выключен. Настройки остаются под ключом `general.swarmClaim` (без переименований и миграций); охранник побудок (#1070) живёт отдельным блоком `general.swarm` (`runWithoutTaskGate`, `cooldownBaseMin`, `cooldownCeilingHours`). Пакетных побудок свободных агентов нет: сопоставление идёт по событиям (завершение прогона, снятие паузы, создание/обновление задачи, истечение аренды), страховочный проход на тике планировщика только подхватывает пропущенное. Автоматическая побудка без задачи в контексте закрывается `skipped` с причиной гейта до старта адаптера (0 токенов). Порядок очереди касты: P0 → эффективная сила феромона (сила + старение − штраф за неудачные прогоны) → возраст → id. Задача, чей последний автоматический прогон завершился без движения, остывает на `cooldownBaseMin · 2^(n−1)` минут (база 30, потолок `cooldownCeilingHours` 24 ч); комментарий или изменение задачи снимает окно сразу. Каста задачи: `issues.caste_key` → каста проекта по умолчанию → метка `role:<key>`; участие агента в очереди — его переключатель `swarmQueueEligible` в карточке, без него — флаг `swarmEligible` его касты (руководитель берёт задачи, если его каста swarmEligible) | Наши файлы: `server/src/myrmidon/swarm-claim/**`, `server/src/myrmidon/castes/**`, `server/src/myrmidon/wake-task-guard.ts`, `packages/shared/src/myrmidon-swarm-claim.ts`, `packages/shared/src/myrmidon-swarm-wake.ts`, `ui/src/components/myrmidon/SwarmClaimSettingsPanel.tsx` | Вендорский хартбит будит агента «поищи работу» и крутит адаптер вхолостую; доска решает сопоставление сама и будит только с задачей | `server/src/myrmidon/swarm-claim/swarm-claim.myrmidon.test.ts`, `packages/shared/src/myrmidon-swarm-claim.myrmidon.test.ts` | Вернуть вендорский цикл «проснись и поищи»: удалить сопоставление и аренды, вернуть пакетные побудки | #1042 |

## changelog-en

### Swarm self-organization: the board matches tasks to free agents itself (1.6.5-SWARM-SELFORG)

- One switch — **Instance → General → "Self-organization (swarm)" → "Enable the swarm"** — and the board itself matches every unassigned ready task with a free agent of the right caste and wakes it with that task in hand. Off by default; the role and company lists are gone — the swarm is either on or off.
- Queue order inside a caste: P0 (critical) first, then the task's effective pheromone strength (strength + aging − penalty for failed runs), then queue age. Tuned in the panel's "Pheromones" block (`general.swarmClaim.pheromone`).
- A task whose last automatic run moved nothing cools down — `general.swarm.cooldownBaseMin` (30 min) doubling per stale run, capped by `general.swarm.cooldownCeilingHours` (24 h); any comment or task change lifts the window at once.
- No more "wake up and look for work" passes: every automatic run starts with a concrete task; a wake without one closes as skipped before the adapter starts — zero tokens.
- User guide: [guides/swarm-self-organization.md](../guides/swarm-self-organization.md) (Russian: [swarm-self-organization.ru.md](../guides/swarm-self-organization.ru.md)).

## changelog-ru

### Самоорганизация роя: доска сама сопоставляет задачи со свободными агентами (1.6.5-SWARM-SELFORG)

- Один переключатель — **Instance → General → «Self-organization (swarm)» → «Enable the swarm»** — и доска сама сопоставляет каждую неназначенную готовую задачу со свободным агентом подходящей касты и будит его уже с задачей в руках. По умолчанию выключено; списки ролей и компаний убраны — рой либо включён, либо выключен.
- Порядок очереди внутри касты: сначала P0 (critical), затем эффективная сила феромона задачи (сила + старение − штраф за неудачные прогоны), затем возраст в очереди. Настраивается в блоке «Феромоны» той же панели (`general.swarmClaim.pheromone`).
- Задача, чей последний автоматический прогон ничего не сдвинул, остывает — `general.swarm.cooldownBaseMin` (30 минут) с удвоением за каждый стылый прогон, потолок `general.swarm.cooldownCeilingHours` (24 ч); любой комментарий или изменение задачи снимает окно сразу.
- Побудок «проснись и поищи работу» больше нет: каждый автоматический прогон стартует с конкретной задачей; побудка без задачи закрывается как skipped до старта адаптера — токены не тратятся.
- Страница пользователя: [guides/swarm-self-organization.ru.md](../guides/swarm-self-organization.ru.md) (английская: [swarm-self-organization.md](../guides/swarm-self-organization.md)).

## settings-en-new

<!-- after: 1.6.1 — SWARM-SETTINGS-UI: queues of roles as instance settings -->

### 1.6.5 — Self-organization (swarm)

Since 1.6.5 the board itself matches every unassigned ready task with a free
agent of the right caste and wakes it with that task in hand. Managed from
**Instance → General → "Self-organization (swarm)"** — writes
`instance_settings.general.swarmClaim` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
applies without a restart, every change lands in the on-screen journal. The
swarm is **off by default**: turn it on with the "Enable the swarm" switch.
The key keeps its historical name `swarmClaim`; the block `general.swarm` is
the separate wake guard (`runWithoutTaskGate`, `cooldownBaseMin`,
`cooldownCeilingHours`, see the F-26 T5 fragment). User page:
[guides/swarm-self-organization.md](guides/swarm-self-organization.md).

| Field (`general.swarmClaim.*`) | Default | What it does |
|---|---|---|
| `enabled` | off | The swarm master switch: off — no matching at all |
| `leaseTtlSec` | 900 | How long one lease lives without a heartbeat, seconds |
| `maxActiveTasks` | 3 | Ceiling of live leases per agent |
| `sweepIntervalSec` | 30 | How often the safety pass runs, seconds; it only picks up what events missed |
| `p0Preemption` | on | A `critical` task goes first regardless of pheromone strength |
| `pheromone.critical` / `.high` / `.medium` / `.low` | 100 / 30 / 10 / 1 | Pheromone strength a new task of this priority starts with |
| `pheromone.agingStepHours` / `agingStep` / `agingCap` | 24 / 1 / 5 | Effective strength grows while the task waits, capped at `agingCap` |
| `pheromone.failPenalty` | 10 | Strength subtracted per failed run since the last task change; never below zero |

The panel's Pheromones block still shows two cooldown fields
(`pheromone.cooldownBaseMin`, `pheromone.cooldownCapMin`); they are removed
from the panel by a separate PR — the working cooldown is the wake guard's
`general.swarm.cooldownBaseMin` / `cooldownCeilingHours`.

## settings-ru-new

<!-- after: 1.6.1 — SWARM-SETTINGS-UI: очереди ролей как настройки инстанса -->

### 1.6.5 — Самоорганизация (рой)

С 1.6.5 доска сама сопоставляет каждую неназначенную готовую задачу со
свободным агентом подходящей касты и будит его уже с задачей в руках.
Управление — **Instance → General → «Self-organization (swarm)»** — пишет
`instance_settings.general.swarmClaim` (`GET`/`PATCH /api/myrmidon/swarm-claim`),
применяется без перезапуска, каждое изменение попадает в журнал на экране.
Рой **по умолчанию выключен**: включается переключателем «Enable the swarm».
Ключ сохраняет историческое имя `swarmClaim`; блок `general.swarm` —
отдельный охранник побудок (`runWithoutTaskGate`, `cooldownBaseMin`,
`cooldownCeilingHours`, см. фрагмент F-26 T5). Страница пользователя:
[guides/swarm-self-organization.ru.md](guides/swarm-self-organization.ru.md).

| Поле (`general.swarmClaim.*`) | По умолчанию | Что делает |
|---|---|---|
| `enabled` | выкл | Главный переключатель роя: выкл — сопоставления нет совсем |
| `leaseTtlSec` | 900 | Сколько живёт одна аренда без хартбита, секунд |
| `maxActiveTasks` | 3 | Потолок живых аренд на агента |
| `sweepIntervalSec` | 30 | Как часто идёт страховочный проход, секунд; он только подхватывает пропущенное событиями |
| `p0Preemption` | вкл | Задача `critical` идёт первой независимо от силы феромона |
| `pheromone.critical` / `.high` / `.medium` / `.low` | 100 / 30 / 10 / 1 | Сила феромона, с которой стартует новая задача этого приоритета |
| `pheromone.agingStepHours` / `agingStep` / `agingCap` | 24 / 1 / 5 | Эффективная сила растёт, пока задача ждёт, с потолком `agingCap` |
| `pheromone.failPenalty` | 10 | Сколько силы вычитается за каждый неудачный прогон после последнего изменения задачи; ниже нуля не опускается |

Блок «Феромоны» панели пока показывает два поля остывания
(`pheromone.cooldownBaseMin`, `pheromone.cooldownCapMin`); отдельный PR уберёт
их из панели — действующее остывание задаёт охранник побудок
`general.swarm.cooldownBaseMin` / `cooldownCeilingHours`.
