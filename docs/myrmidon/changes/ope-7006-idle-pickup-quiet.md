---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### A run that finished without work no longer wakes its own task in a loop (IDLE-PICKUP-QUIET)

- The idle-pickup suppression after a successful run on the same task now holds
  for two hours instead of fifteen minutes
  (`MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS`). A run that ends without
  touching its task (no disposition, no comment) used to leave the task wakeable
  again a quarter of an hour later: the sweep woke it, that run ended the same
  way, and the pair repeated every 15–20 minutes with no new input on the board —
  four idle wakes on one task inside an hour, each one a fresh checkout plus a
  run.
- The window stays silent only while the task does: a comment written after that
  run ended, by anyone other than the run itself, reopens the task for idle
  pickup at once. A comment the run wrote itself (its closing report, matched by
  `created_by_run_id`) and a deleted comment do not.
- The newest success per task decides, and the trigger points are unchanged (the
  periodic sweep and the pass right after `releaseIssueExecutionAndPromote`), so
  both of them keep quiet.

## changelog-ru

### Прогон, завершившийся без дела, больше не будит свою задачу по кругу (IDLE-PICKUP-QUIET)

- Подавление IDLE-PICKUP после успешного прогона на той же задаче теперь
  держится два часа вместо пятнадцати минут
  (`MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS`). Прогон, который завершался,
  ничего не сделав с задачей (без диспозиции и без комментария), оставлял её
  готовой к побудке уже через четверть часа: подметание будило её, новый прогон
  заканчивался так же, и пара повторялась каждые 15–20 минут без нового ввода на
  доске — четыре холостых побудки на одной задаче за час, каждая с новым
  checkout и прогоном.
- Окно молчит, только пока молчит задача: комментарий, написанный после
  окончания того прогона кем угодно, кроме самого прогона, сразу открывает
  задачу для IDLE-PICKUP. Собственный отчёт прогона (совпадение по
  `created_by_run_id`) и удалённый комментарий — не открывают.
- Решает самый свежий успех по задаче, а точки вызова не менялись
  (периодический проход и проход сразу после
  `releaseIssueExecutionAndPromote`) — молчат теперь обе.

## settings-en-replace

| `MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS` | IDLE-PICKUP | `7200000` (2 h) | How many milliseconds after a successful run on a task idle-pickup does not wake THIS SAME task while the task stays silent: a fresh success without disposition is handled by vendor paths (successful-run-handoff, stranded-recovery) — they send an instructive wake, and a duplicate one creates a race. A comment written after that run ended, by anyone other than the run itself, reopens the task at once (a longer window must not starve real input). Other tasks of the agent are not delayed by this | `0` — suppression off (wake even after a fresh success). Non-numeric, negative or fractional — the default |

## settings-ru-replace

| `MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS` | IDLE-PICKUP | `7200000` (2 ч) | Сколько миллисекунд после успешного прогона на задаче idle-pickup не будит ЭТУ ЖЕ задачу, пока та молчит: свежий успех без диспозиции разбирают пути вендора (successful-run-handoff, stranded-recovery) — они шлют инструктивную побудку, а дублирующая создаёт гонку. Комментарий, написанный после окончания того прогона кем угодно, кроме самого прогона, открывает задачу сразу (длинное окно не должно морить реальный ввод голодом). Другие задачи агента это не задерживает | `0` — подавление выключено (будить и после свежего успеха). Нечисловое, отрицательное или дробное — по умолчанию |

## divergence

| IDLE-PICKUP-QUIET | Подавление IDLE-PICKUP после свежего успешного прогона на ТОЙ ЖЕ задаче держится 2 часа вместо 15 минут (`DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS = 7200000`) и действует, только пока задача молчит: комментарий, созданный после окончания того прогона кем угодно, кроме самого прогона (`created_by_run_id`), сразу открывает задачу для побудки — удалённый комментарий и собственный отчёт прогона не открывают. Решает самый свежий успех по задаче; точки вызова (`server/src/services/heartbeat.ts`, `server/src/index.ts`) не менялись | `server/src/myrmidon/idle-pickup.ts` (метка `myrmidon(IDLE-PICKUP-QUIET)`) | Репро OPE-6553 (10.10, 01:05–02:10 UTC): четыре подряд `idle_pickup` на одной задаче каждые 15–20 минут без новых комментариев — холостой прогон возвращал задачу в подметание через 15 минут, и цикл повторялся бесконечно | `server/src/__tests__/idle-pickup.myrmidon.test.ts`: молчаливый успех 40 минут назад — не будится; успех старше окна — будится; комментарий после прогона — будится; собственный отчёт прогона и удалённый комментарий — не будится | Никогда, наше поведение. Снятие: вернуть в `DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS` 15 минут и убрать проверку `issueHasInboundActivitySince` с меткой `myrmidon(IDLE-PICKUP-QUIET)` вместе с её тестами | (этот PR) |

## divergence-replace

<!-- section: Трек 2 — ядро побудок и прогонов -->
| IDLE-PICKUP | Доска сама будит агента, у которого есть назначенные задачи `todo`/`in_progress` и нет живого прогона: сразу после освобождения замка исполнения задачи завершившимся прогоном и по таймеру раз в `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` (по умолчанию 30 с, минимум 5; полный выключатель `MYRMIDON_IDLE_PICKUP_ENABLED`, умолчание — включено). Побудка `idle_pickup` идёт с привязкой к задаче (`issueId`/`taskKey` в контексте, `source: "automation"`) — без 403 cross-issue, который получала непривязанная `on_demand`. Выбирается верхняя готовая задача по приоритету (critical→high→medium→low, затем старее `blockedTransitionAt`); готовая = без незакрытых блокеров (`issue_relations` type `blocks`, открытый ИЛИ отменённый блокер подавляет) и не контейнер (нет открытых дочерних `parentId`), не в разборе принятого плана (`issue_plan_decompositions.status = 'in_flight'` — следующий шаг принадлежит механизму claim) и без свежего успешного прогона на ней самой (`MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS`, по умолчанию 2 ч, `0` — подавление выключено): свежий успех без диспозиции разбирают вендорские successful-run-handoff/stranded-recovery, дубль побудки только создаёт гонку. Окно держится, только пока задача молчит: комментарий, написанный после окончания того прогона кем угодно, кроме самого прогона, открывает задачу сразу (см. IDLE-PICKUP-QUIET). Идемпотентность по факту, а не по ключу: задача будится только пока у неё нет живого прогона (`queued`/`running`/`scheduled_retry`) и нет уже очередной побудки с её `issueId`; ключ `idle_pickup:{issueId}` — только для трассировки. Один прогон за проход. Пауза, режим обслуживания (R3), лимиты допуска (C0), параллельность и дневные потолки уважаются — их проверяет сам путь допуска `enqueueWakeup`, побудка над лимитом остаётся `queued` и стартует обычным подметанием очереди. Действие в журнале: `issue.idle_pickup_wake_emitted` | `server/src/services/heartbeat.ts` (вызов после `releaseIssueExecutionAndPromote`, экземпляр свипера, метод `sweepIdlePickup`), `server/src/index.ts` (периодический проход в цикле планировщика рядом с остальным восстановлением) + `server/src/myrmidon/idle-pickup.ts` | Инцидент 29.09: команда простояла 3 часа при 19 задачах todo — после завершения прогонов новых побудок не было, оператор снимал простой ручным переназначением задачи (оно давало прогон с `invocation_source=assignment`). Первый кирпич SWARM-CLAIM (1.5) | `server/src/__tests__/idle-pickup.myrmidon.test.ts` | Когда вендор начнёт сам будить агента на следующую готовую задачу: удалить куски `myrmidon(IDLE-PICKUP)`, модуль и тест, точки вызова в heartbeat.ts и index.ts | (ветка 1.3) |
