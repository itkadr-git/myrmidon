---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Comment wakes of one task are collected into one run (1.6.6 INBOX-BATCH)

- Comments written on one task inside a short window no longer start one run
  each: the first comment still wakes the assignee at once, but the run it
  queues waits out `MYRMIDON_WAKE_BATCH_WINDOW_MS` (10 s by default) before it
  is claimed, and every comment that arrives inside the window is merged into
  that waiting run's wake — the agent starts **once**, with the whole list of
  comment ids in the order they were written.
- A comment wake is never held when someone is waiting on the run: a run
  checked out by the operator, a run bound to an external chat, an interaction
  wake or its continuation, and any wake that carries no comment id keep the
  immediate per-event delivery.
- The window is a debounce, not a queue: a held run stays an ordinary `queued`
  run, nothing new is written for it, and it is retried when the window closes
  (the same resweep the run-admission gates use), by the periodic queued-run
  sweep and by any later wake of the same agent — a missed timer costs the
  window, never the run.
- `MYRMIDON_WAKE_BATCH_WINDOW_MS=0` (or `off`) switches the batching off and
  returns the board to one run per comment event.

## changelog-ru

### Комментарии одной задачи собираются в один прогон (1.6.6 INBOX-BATCH)

- Комментарии, написанные в одну задачу за короткое окно, больше не запускают
  по прогону на каждый: первый комментарий по-прежнему будит исполнителя
  сразу, но созданный им прогон ждёт закрытия окна
  `MYRMIDON_WAKE_BATCH_WINDOW_MS` (по умолчанию 10 с) до старта, и каждый
  комментарий, пришедший внутрь окна, доливается в побудку ждущего прогона —
  агент стартует **один раз**, с полным списком идентификаторов комментариев в
  порядке их написания.
- Побудка не придерживается, когда прогон кто-то ждёт: прогон, взятый
  оператором вручную, прогон, привязанный к внешнему чату, побудка карточки и
  её продолжение, а также любая побудка без идентификатора комментария —
  доставляются сразу, как раньше.
- Окно — это дебаунс, а не очередь: придержанный прогон остаётся обычным
  `queued`-прогоном, для него ничего нового не пишется, и он повторяется на
  закрытии окна (тот же проход очереди, что у ворот допуска прогонов), на
  плановом проходе очереди и на любой следующей побудке того же агента —
  пропущенный таймер стоит окна, но не прогона.
- `MYRMIDON_WAKE_BATCH_WINDOW_MS=0` (или `off`) выключает сборку и возвращает
  доске доставку «один прогон на событие».

## divergence

| INBOX-BATCH | Комментарии одной задачи собираются в один прогон: проход допуска очереди (`startNextQueuedRunForAgent`) больше не забирает прогон, чья побудка — обычный комментарий (`issue_commented`, `issue_reopened_via_comment`, `issue_comment_mentioned`) и чьё окно `MYRMIDON_WAKE_BATCH_WINDOW_MS` ещё не закрылось; такой прогон остаётся `queued`, а комментарии, пришедшие внутрь окна, доливаются в него штатным слиянием (`admitWakeBehindIssueExecution` → `mergeWakeCommentIds`), поэтому агент стартует один раз с полным списком `wakeCommentIds` в порядке поступления. Придержанный прогон повторяется на закрытии окна (`scheduleWakeBatchResweep`, тот же однотиковый таймер `scheduleQueuedResweep`, что у ворот допуска), плановым проходом очереди и любой следующей побудкой агента. Не придерживаются: прогон, взятый оператором (harness checkout), привязанный к внешнему чату, побудка карточки и её продолжение, побудка без идентификатора комментария. Решение целиком в `server/src/myrmidon/wake-batch.ts` | Вендор: `server/src/services/heartbeat.ts` (проход допуска очереди в `startNextQueuedRunForAgent` — метка `myrmidon(1.6.6 INBOX-BATCH)` — и helper `scheduleWakeBatchResweep` рядом с `scheduleAdmissionResweep`) | Несколько комментариев по одной задаче за короткое окно стоили по прогону на каждый: каждый прогон — это контейнер, сессия и вызов модели ради одной фразы, а агент читал комментарии по одному и отвечал на уже устаревшую часть. Вендор собирает комментарии только в живое исполнение (задача занята), у свободной задачи окна не было | `server/src/myrmidon/wake-batch.myrmidon.test.ts` | Когда вендор сам начнёт дебаунсить комментарии по одной задаче: убрать фильтр `splitBatchedWakeRuns` из `startNextQueuedRunForAgent`, helper `scheduleWakeBatchResweep` и `server/src/myrmidon/wake-batch.ts` с тестом | этот PR |

## settings-en

| `MYRMIDON_WAKE_BATCH_WINDOW_MS` | INBOX-BATCH | `10000` (10 s) | How long a run woken by a comment on an idle task waits before it is claimed, so that the comments written inside the window merge into it and the agent starts once with the whole list of comment ids | `0` — no batching (one run per comment event); `off`/`false`/`no` — the same; non-numeric or negative — the default; a value below 250 ms is raised to 250 ms and one above 300000 ms (5 min) is capped |

## settings-ru

| `MYRMIDON_WAKE_BATCH_WINDOW_MS` | INBOX-BATCH | `10000` (10 с) | Сколько ждёт старта прогон, поднятый комментарием по свободной задаче, чтобы комментарии, написанные внутри окна, доливались в него и агент стартовал один раз с полным списком идентификаторов | `0` — без сборки (один прогон на событие); `off`/`false`/`no` — то же; не число или отрицательное — умолчание; значение меньше 250 мс поднимается до 250 мс, больше 300000 мс (5 мин) — обрезается |