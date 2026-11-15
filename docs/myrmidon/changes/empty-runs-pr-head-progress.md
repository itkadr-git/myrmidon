---
divergence-section: Трек 1 — платформа
---

## changelog-en

### A push to the task's PR now counts as progress of a run that hands the task back (EMPTY-RUNS-1)

- The EMPTY-RUNS-1 guard treats a run that moves a task `in_progress -> todo` with a note as having made no progress.
  An engineer's run does exactly that after pushing commits to the task's pull request, and a push leaves no row under
  the run, so on 16.11 the task OPE-13243 cooled down (two runs, a 60 minute pause) while the head of its PR changed in
  every run.
- When the head of a task's pull request moves (`metadata.headSha` of the `pull_request` work product changes, seen by
  the GitHub `pull_request` event), the board now writes an `issue.work_product_head_changed` activity row on the task
  (actor `system`, details `workProductId`, `headShaChanged: true`, `fromSha`, `toSha`, and `sender`, the GitHub login, when the event has one). Nothing is written when the head
  stays the same or the event carries none. The row is not part of the progress and new-input action lists, so it wakes
  and thaws nothing by itself.
- The no-progress read of the task cooling and of the rewake throttle credits a run with progress when such a row, from
  any actor, falls between the start of the run and its end plus 15 minutes (the webhook arrives after the push). One
  head change is credited to one run: the run that holds it, otherwise the run that ended last before it; a run that has
  not finished ends at now. At most 200 newest rows are read. A run without a head change is judged as before.

## changelog-ru

### Пуш в PR задачи теперь считается прогрессом прогона, который возвращает задачу в очередь (EMPTY-RUNS-1)

- Защита EMPTY-RUNS-1 считает, что прогон, вернувший задачу `in_progress -> todo` с заметкой, прогресса не сделал.
  Именно так заканчивается прогон инженера после пуша коммитов в PR задачи, а пуш не оставляет записи под прогоном: 16.11
  задача OPE-13243 остыла (два прогона, пауза 60 минут), хотя голова её PR менялась в каждом прогоне.
- Когда голова PR задачи меняется (`metadata.headSha` рабочего продукта `pull_request`, по событию GitHub
  `pull_request`), доска пишет в журнал задачи строку `issue.work_product_head_changed` (актёр `system`, в details
  `workProductId`, `headShaChanged: true`, `fromSha`, `toSha`, а также `sender` — логин GitHub, если он есть в событии). Если голова та же или в событии её нет, строки нет.
  Строки нет в списках «прогресс» и «новый вход», поэтому сама по себе она никого не будит и не размораживает.
- Проверка «без продвижения» в остывании задачи и в тормозе повторных побудок засчитывает прогону прогресс, если такая
  строка от любого актёра попала между началом прогона и его концом плюс 15 минут (вебхук приходит после пуша).
  Одна смена головы засчитывается одному прогону: тому, в чьём промежутке она лежит, иначе закончившемуся последним до
  неё; незавершённый прогон длится до текущего момента. Читаются не более 200 новейших строк. Прогон без смены головы
  оценивается как раньше.

## divergence

| EMPTY-RUNS-1 (голова PR) | Смена `metadata.headSha` рабочего продукта PR пишет в журнал задачи строку `issue.work_product_head_changed`; остывание задачи и тормоз повторных побудок считают прогрессом прогон, в окне которого (старт … конец + 15 мин) есть такая строка | `server/src/services/github-connection-events.ts`, `server/src/services/heartbeat.ts`, `server/src/services/issue-rewake-throttle.ts` (метка `myrmidon(EMPTY-RUNS-1)`); свой код: `server/src/services/pr-head-change-progress.ts`, `server/src/myrmidon/wake-task-guard.ts` | 16.11: у OPE-13243 каждый прогон менял голову PR #3287 и возвращал задачу в `todo`, задача остыла как «без продвижения» | `server/src/__tests__/github-connection-events.test.ts`, `server/src/__tests__/issue-rewake-throttle-return-to-queue.test.ts`, `server/src/myrmidon/wake-task-guard-parked-task.myrmidon.test.ts` | Когда вендор сам считает пуш в PR задачи прогрессом прогона — удалить строку, `readRunIdsWithPrHeadChange` и `collectRunIdsWithPrHeadChange` | (этот PR) |
