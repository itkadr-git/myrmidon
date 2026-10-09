## changelog-ru

### 1.6.5 F-26 SWARM-WAKE-FIX: очередь роя сама выдаёт неназначенные задачи (OPE-6608)

- Idle-проход роя больше не будит агента «поищи работу»: проход сам назначает верхнюю
  задачу очереди свободному агенту роли, пишет лиз того же вида, что и checkout
  (`issue_claims`), и только после этого будит его уже с этой задачей. Нет свободного
  агента роли — не будится никто; неудачная запись лиза откатывает назначение.
- Свободные агенты роли упорядочены по загруженности (живые лизы), при равенстве — по
  времени последней активности: дольше всех простаивающий идёт первым, «голова списка»
  больше не прилипает.
- Участие агента в очереди — отдельный переключатель в карточке агента (метаданные,
  `swarmQueueEligible`); по умолчанию он включён только у роли исполнителя, поэтому лиды,
  ревьюеры и архитектор задачи очереди не забирают. Каста вне области отвечает причиной
  `caste_excluded`, агент вне области — `agent_excluded`.
- Размер прохода `idleWakeBatch` стал настройкой инстанса (панель «Role queues
  (SWARM-CLAIM)»), переменная `MYRMIDON_SWARM_IDLE_WAKE_BATCH` остаётся форсированным
  переопределением. Там же — живые цифры очереди: «в очереди», «захвачено за час»,
  «отменено за час».
- Подписи «Pilot roles / Pilot companies» заменены на «Roles in scope / Companies in
  scope»: пустой список означает «все», это ограничение области, а не включённый
  пилотный режим.

## changelog-en

### 1.6.5 F-26 SWARM-WAKE-FIX: the swarm queue hands out unassigned tasks itself (OPE-6608)

- The swarm idle pass no longer wakes an agent to "go and look for work": the pass assigns
  the top task of the queue to a free agent of the role, writes the same kind of lease a
  checkout writes (`issue_claims`), and only then wakes that agent with the task in hand.
  No free agent of the role — nobody is woken; a failed lease write reverts the assignment.
- Free agents of a role are ordered by load (live leases) and, among equals, by last
  activity: the longest idle agent comes first, so the head of the list no longer sticks.
- An agent's participation in the queue is its own switch (agent metadata,
  `swarmQueueEligible`), on by default only for the executor role, so leads, reviewers and
  the architect no longer take queue tasks. A caste outside the scope answers
  `caste_excluded`, an agent outside it — `agent_excluded`.
- The pass size `idleWakeBatch` became an instance setting ("Role queues (SWARM-CLAIM)"
  panel); `MYRMIDON_SWARM_IDLE_WAKE_BATCH` stays as a forced override. The same panel shows
  live queue counters: queued, claimed in the last hour, cancelled in the last hour.
- The labels "Pilot roles / Pilot companies" became "Roles in scope / Companies in scope":
  an empty list means all, it is a scope limit, not a pilot mode.

## settings-ru-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | не задана (без ограничения) | Переопределение области очередей по ролям: имена ролей через запятую (например `engineer`). Клеймят только агенты перечисленных ролей; пустое значение — все роли (**пусто = все**, это не «пилот»). Поле интерфейса «Roles in scope» держит тот же список | Не задана — значение из интерфейса. Пустая — без ограничения. Пробелы вокруг записей обрезаются |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | не задана (без ограничения) | Переопределение области очередей по компаниям: id компаний через запятую. Клеймят только перечисленные компании; пустое значение — все (**пусто = все**). Поле интерфейса «Companies in scope» держит тот же список | Не задана — значение из интерфейса. Пустая — без ограничения |
| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.1 SWARM-IDLE-WAKE | `5` | Переопределение поля панели `idleWakeBatch`: верхняя граница числа задач, которые один idle-проход роя отдаёт агентам за раз. С 1.6.5 (SWARM-WAKE-FIX) проход сначала сам назначает задачу свободному агенту роли и пишет лиз, и только потом будит его этой задачей — поэтому батч считает выданные задачи, а не «побудки» | От 1 до 25; вне диапазона или не число — подрезается/откат к умолчанию. Не задана — значение из панели «Role queues (SWARM-CLAIM)» |

## settings-en-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | unset (no restriction) | Override of the queue scope by role: comma-separated role names (e.g. `engineer`). Only agents of the listed roles claim; an empty value means every role (**empty = all**; this is a scope, not a "pilot"). The "Roles in scope" field holds the same list | Unset — the UI value applies. Empty — no restriction. Whitespace around an entry is trimmed |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | unset (no restriction) | Override of the queue scope by company: comma-separated company ids. Only the listed companies claim; an empty value means every company (**empty = all**). The "Companies in scope" field holds the same list | Unset — the UI value applies. Empty — no restriction |
| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.1 SWARM-IDLE-WAKE | `5` | Override of the panel field `idleWakeBatch`: the upper bound of tasks one idle pass hands to agents. Since 1.6.5 (SWARM-WAKE-FIX) the pass assigns the task to a free agent of the role and writes the lease first, and only then wakes that agent with it — so the batch counts handed-out tasks, not "wakes" | From 1 to 25; out of range or non-numeric — clamped/falls back to the default. Unset — the value of the "Role queues (SWARM-CLAIM)" panel applies |

## settings-ru-new

### 1.6.5 — SWARM-WAKE-FIX (OPE-6608): очередь роя сама выдаёт неназначенные задачи

Разбор `ops/audit/swarmdiag-20261009.md`: за 7 дней 3259 прогонов `swarm_claim_queue`
отменены и **ни одна** неназначенная задача не взята в работу. Причина была в порядке
действий idle-прохода: он будил агента с `payload.issueId` неназначенной задачи и
рассчитывал, что захват произойдёт на checkout прогона; но диспетчер запуска
(`server/src/modules/run-dispatch/domain/policy.ts`, `decideIssueOwnership`) видит
исполнителя задачи = `NULL`, а агента прогона — другим и отменяет побудку со статусом
`skipped` («issue assignee changed before the queued run could start»). До checkout
прогон не доходил никогда.

С 1.6.5 проход работает в другом порядке:

1. **Захват на сервере до побудки.** Для каждой роли с непустой готовой очередью проход
   сам назначает верхнюю задачу свободному агенту роли и сразу пишет лиз того же вида,
   что и checkout (`issue_claims`), и только после этого будит его — побудка всегда несёт
   id уже назначенной ему задачи. Побудок «иди поищи работу» без конкретной задачи нет.
   Если свободного агента роли нет — не будится никто. Если запись лиза не удалась,
   назначение откатывается (задача возвращается в очередь).
2. **Справедливый выбор агента.** Свободные агенты роли упорядочены по загруженности
   (живые лизы), при равной загруженности — по времени последней активности: дольше всех
   простаивающий идёт первым. Верхушка списка больше не «прилипает» — при следующем
   проходе первым идёт тот, кто простаивал дольше.
3. **Кто берёт задачи очереди.** У агента есть собственный переключатель участия в
   очереди (метаданные агента, `swarmQueueEligible`), по умолчанию — только роль
   исполнителя: у лида, ревьюера, архитектора и прочих агентов с `role=engineer` он
   выключен. Агент вне области отвечает причиной `agent_excluded`, каста вне области —
   `caste_excluded`.

### Как включить и проверить

1. Instance → General → **«Role queues (SWARM-CLAIM)»**: включить главный выключатель
   `enabled`. Поля «Roles in scope» / «Companies in scope» — ограничение области, **пустое
   поле = все** роли и все компании (раньше подписи называли это «пилотом» и пугали
   пустым списком).
2. Там же выставить размер прохода `idleWakeBatch` (прежняя переменная
   `MYRMIDON_SWARM_IDLE_WAKE_BATCH`, теперь настройка инстанса) и, при необходимости,
   TTL лиза, потолок активных задач и интервал сторожа — всё применяется без перезапуска.
3. Сравнение источников (foraging) настраивается на соседней секции
   **«Learning (foraging)»** — той же страницы Instance → General, env не нужен.
4. Проверка: в панели под настройками строка **«Queues right now»** — «в очереди»,
   «захвачено за час», «отменено за час». Через минуту после включения на непустой
   очереди «захвачено за час» должно стать ≥ 1, а «отменено за час» — не расти. Второй
   способ: в задаче появляется исполнитель без участия человека (`assigneeAgentId`
   проставлен, живой лиз в `issue_claims`), затем у агента стартует прогон с причиной
   `swarm_claim_queue`, а не `skipped`.

## settings-en-new

### 1.6.5 — SWARM-WAKE-FIX (OPE-6608): the swarm queue hands out unassigned tasks itself

The analysis in `ops/audit/swarmdiag-20261009.md`: over 7 days 3259 `swarm_claim_queue`
runs were cancelled and **not one** unassigned task was taken into work. The cause was the
order of the idle pass: it woke an agent with the `payload.issueId` of a task that belonged
to nobody, expecting the claim to happen at the run's checkout. The run admission
(`server/src/modules/run-dispatch/domain/policy.ts`, `decideIssueOwnership`) reads the
task's assignee as `NULL` while the run carries another agent, so it cancels the wake with
status `skipped` ("Cancelled because issue assignee changed before the queued run could
start"). The run never reached checkout.

Since 1.6.5 the pass works the other way round:

1. **The server claims before the wake.** For every role with a non-empty ready queue the
   pass assigns the top task to a free agent of that role and immediately writes the same
   kind of lease a checkout writes (`issue_claims`); only then does it wake that agent — a
   wake always carries the id of a task already assigned to it. There is no "go and look
   for work" wake without a concrete task. When the role has no free agent, nobody is woken.
   If the lease write fails, the assignment is reverted and the task goes back to the queue.
2. **The agent is picked fairly.** Free agents of the role are ordered by their load (live
   leases), and among equals by last activity: the longest idle agent comes first, so the
   head of the list no longer sticks.
3. **Who may take tasks from the queue.** An agent has its own switch for the queue (agent
   metadata, `swarmQueueEligible`); by default it is on only for the executor role — for a
   lead, a reviewer, the architect and other agents that also carry `role=engineer` it is
   off. An agent outside the scope answers `agent_excluded`, a caste outside it answers
   `caste_excluded`.

### How to turn it on and check it

1. Instance → General → **"Role queues (SWARM-CLAIM)"**: turn the `enabled` master switch
   on. "Roles in scope" / "Companies in scope" only *limit* the scope — **an empty field
   means all** roles and all companies (the labels used to call this a "pilot", which made
   an empty list look wrong).
2. Set the pass size `idleWakeBatch` there (the former
   `MYRMIDON_SWARM_IDLE_WAKE_BATCH` variable, now an instance setting) plus, if needed, the
   lease TTL, the per-agent ceiling and the sweep interval — all apply without a restart.
3. The foraging source comparison lives in the neighbouring **"Learning (foraging)"**
   section of the same Instance → General page; no env is needed.
4. To check: under the settings the panel shows **"Queues right now"** — queued, claimed in
   the last hour, cancelled in the last hour. A minute after switching on with a non-empty
   queue "claimed in the last hour" must be ≥ 1 and "cancelled in the last hour" must not
   grow. Second way: a task gains an assignee without a human (`assigneeAgentId` set, a live
   lease in `issue_claims`) and the agent starts a run with reason `swarm_claim_queue`
   instead of `skipped`.