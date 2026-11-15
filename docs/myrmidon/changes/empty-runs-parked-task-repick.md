---
divergence-section: Трек 1 — платформа
---

## changelog-en

### An agent no longer re-picks its own parked task every sweep (EMPTY-RUNS-1)

- On 13.11 a third of all runs (258 of 780 in eight hours) were `swarm_matched` / `idle_pickup` pickups, and 217 of
  them changed nothing: three service bots took their own `todo` tasks 176 times (ten tasks, about 40 M input tokens),
  wrote "no new data, leaving it in todo" and handed the task back. Both guards that exist for this loop were blind to
  it. The task cooling (`wake-task-guard`) trusts run liveness, and liveness marks a run "advanced" for any activity
  row attributed to it, the board's own included (the checkout claim, the tool delivery, the echo of the final text):
  500 of 539 succeeded runs without a result were "advanced", so the cooling never started. The rewake throttle read
  the PATCH `in_progress -> todo` and the note next to it as issue-visible progress, so its no-progress streak never
  started either.
- The rewake throttle no longer counts a hand-back of the task to the queue as progress: an `issue.updated` that moves
  the task `in_progress -> todo` and changes nothing but the execution lock and the assignment bookkeeping, and the
  comment the same run leaves next to it. A run that hands the task back but leaves a document, a work product, a
  sub-task, a blocker, a monitor, an interaction or a real field change still counts, and so does a comment of a run
  that did not hand the task back. After two such runs the escalating pause starts, after six in the lookback window
  the task is frozen and the lead is asked, as for every other no-progress streak.
- The task cooling no longer takes "advanced" as proof for a task that sits in `todo`: an automatic run that left no
  issue-visible progress there (the same read as the throttle's) is stale, so the task cools for 30 minutes, then 60,
  120 and so on up to `general.swarm.cooldownCeilingHours`. The cooling list shows such tasks with the reason
  `no_progress`. A user or another agent moving the task lifts the cooling as before; tasks in `in_progress`,
  `in_review` or `blocked` are judged exactly as before.
- Run liveness itself is not changed: it also drives continuations, the successful-run hand-off and stranded-task
  recovery.

## changelog-ru

### Агент больше не берёт свою «припаркованную» задачу на каждом проходе (EMPTY-RUNS-1)

- 13.11 треть всех прогонов (258 из 780 за восемь часов) были подборами `swarm_matched` / `idle_pickup`, и 217 из них
  ничего не изменили: три служебных бота 176 раз брали свои задачи в `todo` (десять задач, около 40 млн входных
  токенов), писали «новых данных нет, оставляю в todo» и возвращали задачу. Обе защиты от такого цикла его не видели.
  Остывание задачи (`wake-task-guard`) доверяет оценке прогона, а она ставит «advanced» за любую запись журнала,
  привязанную к прогону, включая служебные записи самой доски (захват задачи, доставка инструментов, эхо итогового
  текста): 500 из 539 успешных прогонов без результата были «advanced», и остывание не включалось. Тормоз повторных
  побудок считал PATCH `in_progress -> todo` и заметку рядом с ним видимым продвижением, поэтому серия «без
  продвижения» тоже не начиналась.
- Тормоз повторных побудок больше не считает продвижением возврат задачи в очередь: запись `issue.updated`, которая
  переводит задачу `in_progress -> todo` и не меняет ничего, кроме замка исполнения и служебных полей назначения, и
  комментарий, оставленный тем же прогоном рядом с ней. Прогон, вернувший задачу, но оставивший документ, результат
  работы, подзадачу, блокер, монитор, вопрос или настоящее изменение поля, по-прежнему считается; считается и
  комментарий прогона, который задачу не возвращал. После двух таких прогонов включается нарастающая пауза, после
  шести в окне наблюдения задача замораживается и вопрос уходит лиду — как для любой серии без продвижения.
- Остывание задачи больше не принимает «advanced» на веру для задачи в `todo`: автоматический прогон, не оставивший на
  ней видимого продвижения (та же проверка, что у тормоза), считается застойным, и задача остывает 30 минут, затем 60,
  120 и далее до `general.swarm.cooldownCeilingHours`. В списке остывающих такие задачи идут с причиной `no_progress`.
  Движение задачи пользователем или другим агентом снимает остывание, как и раньше; задачи в `in_progress`,
  `in_review` и `blocked` оцениваются как раньше.
- Сама оценка прогона (liveness) не менялась: от неё зависят продолжения, передача после успешного прогона и
  восстановление зависших задач.

## divergence

| EMPTY-RUNS-1 | Возврат задачи в очередь (`in_progress -> todo` без других изменений) и заметка того же прогона не считаются продвижением в тормозе повторных побудок; остывание задачи в `todo` считает «advanced»-прогон без видимого продвижения застойным | `server/src/services/issue-rewake-throttle.ts`, `server/src/services/heartbeat.ts` (метка `myrmidon(EMPTY-RUNS-1)`); свой код: `server/src/myrmidon/wake-task-guard.ts` | 13.11: три служебных бота 176 раз за 8 ч брали десять своих задач в `todo` и возвращали их без изменений; тормоз считал возврат продвижением, остывание доверяло «advanced» | `server/src/__tests__/issue-rewake-throttle-return-to-queue.test.ts`, `server/src/__tests__/heartbeat-issue-rewake-throttle.test.ts`, `server/src/myrmidon/wake-task-guard-parked-task.myrmidon.test.ts` | Когда вендор сам не считает возврат задачи в очередь продвижением прогона — удалить `isReturnToQueue`, `collectRunIdsWithIssueProgress` и тесты | (этот PR) |
