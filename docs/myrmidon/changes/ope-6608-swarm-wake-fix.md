## changelog-ru

### 1.6.5 F-26 SWARM (OPE-6608): доска сама сопоставляет задачу со свободным агентом

- На доске появился сопоставитель (`server/src/myrmidon/swarm-claim/matcher.ts`, проект §3):
  по готовой задаче он находит свободного агента её касты в её гнезде, в одной
  транзакции пишет аренду (`issue_claims`) и назначает исполнителя, и только после этого
  будит его — побудка всегда несёт id уже принадлежащей ему задачи (ключ
  `swarm_matched:<issueId>`). Нет свободного агента — никто не будится. Отказ выбора на
  одной задаче не закрывает очередь.
- Сопоставитель подключён к боевому коду: страховочный проход сторожа
  (`swarmClaimSweeper.sweep()`) вызывает `matchCompany` вместо старого idle-прохода;
  release-путь прогона (`heartbeat.ts`) при включённом рое вызывает `forAgent`
  освободившегося агента вместо idle-pickup; истечение аренды у `todo` без прогона снимает
  исполнителя (активность `issue.swarm_claim.unassigned_on_expiry`) и перематчивает задачу;
  явный pull `POST …/swarm-claim/claim` идёт через тот же `forAgent`.
- Своя назначенная задача идёт первой: агент получает собственную готовую задачу, у которой
  нет ни живой аренды, ни побудки в полёте. Назначение только `assignee IS NULL` задач было
  регрессией — такая задача больше не доставалась своему агенту ни разу.
- Ротации нет и не пишется: выбор — запах (T10), при равных счётах детерминированная ничья
  по `agents.id`; «кто дольше простаивает» из ядра убрано.
- Удалено вместе с проходом: `sweepIdleWakes`, `idle-wake.ts`, `idle-queue.ts`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH` и его чтение в `sweep.ts`, `wakeNextAgentForIssueRole`
  (снятие аренды и перематч — вместо «разбуди следующего агента касты»).
- Пилот в серверном коде убран: `isSwarmClaimEnabledFor` больше не гейтит ни checkout-хук,
  ни claim. Переменные `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` / `_COMPANY_IDS` и поле
  `idleWakeBatch` в схеме настроек остаются до слияния T2 (OPE-6614 правит тот же файл
  `myrmidon-swarm-claim.ts`) и удаляются вместе с ним. Область очередей сужается только
  справочником каст (`swarmEligible`) и переключателем в карточке агента.
- Касты и гнёзда — по контрактам T3 (порты `resolveTaskCaste`/`agentNests`): до их слияния
  каста задачи — метка `role:` либо каста по умолчанию, гнёзд нет; порты уже проведены
  через сопоставитель и каста-директорию.

## changelog-en

### 1.6.5 F-26 SWARM (OPE-6608): the board pairs a task with a free agent itself

- The board now has a matcher (`server/src/myrmidon/swarm-claim/matcher.ts`, design §3): for a
  ready task it finds a free agent of the task's caste in its nest, writes the lease
  (`issue_claims`) and sets the assignee in one transaction, and only then wakes that agent —
  a wake always carries the id of a task that already belongs to it (key
  `swarm_matched:<issueId>`). No free agent — nobody is woken. A pick refusing one task does
  not close the queue.
- The matcher is wired into the production path: the sweeper's safety net
  (`swarmClaimSweeper.sweep()`) calls `matchCompany` instead of the old idle pass; the release
  path of a run (`heartbeat.ts`) calls `forAgent` for the freed agent instead of idle-pickup
  while the swarm is on; a lease expired on a `todo` with no run behind it takes the owner off
  the task (activity `issue.swarm_claim.unassigned_on_expiry`) and re-matches it; the explicit
  pull `POST …/swarm-claim/claim` goes through the same `forAgent`.
- The agent's own assigned task comes first: it is woken on a ready task of its own that has
  neither a live lease nor a wake in flight. Assigning only `assignee IS NULL` tasks was a
  regression — such a task never reached its own agent again.
- There is no rotation, and none is written: the pick is the scent (T10), a full tie goes to
  the smallest `agents.id`; the "longest idle first" order is gone from the core.
- Removed with the pass: `sweepIdleWakes`, `idle-wake.ts`, `idle-queue.ts`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH` and its read in `sweep.ts`, `wakeNextAgentForIssueRole`
  (releasing the lease and re-matching replaces "wake the next agent of the caste").
- The pilot is gone from the server code: `isSwarmClaimEnabledFor` no longer gates the
  checkout hook or the claim. The variables `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` /
  `_COMPANY_IDS` and the `idleWakeBatch` settings field stay until T2 merges (OPE-6614 edits
  the same `myrmidon-swarm-claim.ts`) and leave with it. The queue scope is narrowed only by
  the caste directory (`swarmEligible`) and the agent's own card switch.
- Castes and nests follow the T3 contracts (ports `resolveTaskCaste`/`agentNests`): until they
  merge, a task's caste is its `role:` label or the default caste and there are no nests; the
  ports are already threaded through the matcher and the caste directory.

## settings-ru-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | не задана (без ограничения) | **С 1.6.5 (OPE-6608) не влияет на работу**: пилот в серверном коде удалён, переменная осталась только в схеме настроек до слияния T2 (OPE-6614) и будет удалена вместе с ней. Область очередей сужается справочником каст (`swarmEligible`) и переключателем в карточке агента. Поле интерфейса «Roles in scope» сохраняет список, но клейм его больше не читает | Не задана — без ограничения. Значение игнорируется |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | не задана (без ограничения) | **С 1.6.5 (OPE-6608) не влияет на работу** по той же причине: гейты пилота (`isSwarmClaimEnabledFor`) убраны из checkout-хука и из claim. Удаляется вместе с T2 | Не задана — без ограничения. Значение игнорируется |
| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.1 SWARM-IDLE-WAKE | `5` | **Выведена из употребления в 1.6.5 (OPE-6608)**: idle-прохода с пачкой побудок больше нет, его место занял сопоставитель на доске — одна задача ↔ один свободный агент её касты за проход, без верхней границы. Переменная и поле панели `idleWakeBatch` читаются только схемой настроек и удаляются вместе с T2 | Значение не читается ни одним проходом |

## settings-en-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | unset (no restriction) | **Has no effect since 1.6.5 (OPE-6608)**: the pilot is removed from the server code; the variable survives only in the settings schema until T2 (OPE-6614) merges and will be deleted with it. The queue scope is narrowed by the caste directory (`swarmEligible`) and the agent's own card switch. The "Roles in scope" field keeps the list, the claim no longer reads it | Unset — no restriction. The value is ignored |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | unset (no restriction) | **Has no effect since 1.6.5 (OPE-6608)** for the same reason: the pilot gates (`isSwarmClaimEnabledFor`) are gone from the checkout hook and the claim. Removed together with T2 | Unset — no restriction. The value is ignored |
| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.1 SWARM-IDLE-WAKE | `5` | **Retired in 1.6.5 (OPE-6608)**: the idle pass with its wake batch is gone — the board-side matcher pairs one task with one free agent of its caste per pass, with no upper bound. The variable and the panel field `idleWakeBatch` are read only by the settings schema and are removed together with T2 | No pass reads the value |

## settings-ru-new

### 1.6.5 — SWARM (OPE-6608): сопоставление на доске, без побудок «поищи работу»

Разбор `ops/audit/swarmdiag-20261009.md`: за 7 дней 3259 прогонов `swarm_claim_queue`
отменены и **ни одна** неназначенная задача не взята в работу. Причина — порядок действий
старого idle-прохода: он будил агента с `payload.issueId` задачи без исполнителя и ожидал
захвата на checkout; диспетчер запуска (`decideIssueOwnership`) видит `assignee = NULL` и
другого агента в прогоне и отменяет побудку как `reassigned` (`skipped`). До checkout прогон
не доходил.

С 1.6.5 сопоставление делает сама доска: готовая задача встречает свободного агента своей
касты и своего гнезда (сначала — своя назначенная задача агента), задача становится его
собственной (аренда + исполнитель), и только потом он получает прогон с этой задачей.
Побудок «иди поищи работу» нет; нет свободного агента — задача ждёт первого освободившегося
подходящей касты. Отбор — по запаху (T10; при равных счётах — детерминированная ничья по
`agents.id`), без ротации и без «кто дольше простаивает».

Как включить и проверить:

1. Instance → General → **«Role queues (SWARM-CLAIM)»**: включить главный выключатель
   `enabled`. Изменения применяются без перезапуска (переключатель читается на каждом
   событии).
2. Проверка: в панели под настройками строка **«Queues right now»** — «в очереди»,
   «захвачено за час», «отменено за час». Через минуту после включения на непустой очереди
   «захвачено за час» должно стать ≥ 1, а «отменено за час» — не расти. Второй способ: у
   задачи появляется исполнитель без человека (`assigneeAgentId` проставлен, живая аренда в
   `issue_claims`), затем у агента стартует прогон с причиной `swarm_matched`, а не
   `skipped`.
3. Ставка счётчиков: `readSwarmQueueCounters` учитывает и прежние отмены с причиной
   `swarm_claim_queue`, и новые `swarm_matched` — рост «отменено за час» после выката виден
   сразу.

## settings-en-new

### 1.6.5 — SWARM (OPE-6608): the board pairs tasks with free agents, no "look for work" wakes

The analysis in `ops/audit/swarmdiag-20261009.md`: over 7 days 3259 `swarm_claim_queue` runs
were cancelled and **not one** unassigned task was taken into work. The cause was the order of
the old idle pass: it woke an agent with the `payload.issueId` of a task that belonged to
nobody, expecting the claim on checkout; the run admission (`decideIssueOwnership`) sees
`assignee = NULL` and another agent in the run and cancels the wake as `reassigned`
(`skipped`). The run never reached checkout.

Since 1.6.5 the board itself pairs: a ready task meets a free agent of its caste and nest (the
agent's own assigned task first), the task becomes that agent's own (lease + assignee), and
only then does it get a run carrying the task. There is no "go and look for work" wake; with no
free agent the task waits for the first eligible one to free up. The pick is the scent (T10; a
full tie goes to the smallest `agents.id`) — no rotation, no "longest idle first".

How to turn it on and check it:

1. Instance → General → **"Role queues (SWARM-CLAIM)"**: turn the `enabled` master switch on.
   Changes apply without a restart (the switch is read on every event).
2. To check: under the settings the panel shows **"Queues right now"** — queued, claimed in the
   last hour, cancelled in the last hour. A minute after switching on with a non-empty queue
   "claimed in the last hour" must be ≥ 1 and "cancelled in the last hour" must not grow.
   Second way: a task gains an assignee without a human (`assigneeAgentId` set, a live lease in
   `issue_claims`) and the agent then starts a run with reason `swarm_matched` instead of
   `skipped`.
3. Counter note: `readSwarmQueueCounters` counts both the old cancellations under reason
   `swarm_claim_queue` and the new `swarm_matched` ones, so the growth of "cancelled in the
   last hour" is visible right after the roll-out.