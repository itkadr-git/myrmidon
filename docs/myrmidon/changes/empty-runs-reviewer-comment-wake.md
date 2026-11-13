---
divergence-section: Трек 1 — платформа
settings-section: Track 5 — operations
---

## changelog-en

### The executor's comment does not wake the reviewer while the review stage waits for green CI (EMPTY-RUNS-2)

- A hand-off to review goes through the green-CI admission gate: while the `CI result` of the pull request head is not green the reviewer is not woken, and the board arms its "Review CI wait" monitor, whose tick wakes the reviewer once the head CI is final. The comment path did not know about the gate: the executor's closing note, posted as a separate request seconds after the hand-off, woke the reviewer with `issue_commented` past it. The reviewer run found an unfinished CI, could not record a verdict and ended with one more comment. On the release board (12–13.11.2026) 111 of 136 reviewer comment wakes came from an engineer's comment, 89 of them while the monitor was armed.
- Both comment paths (`POST /issues/:id/comments` and `PATCH /issues/:id` with a comment) now apply the same admission decision as the status change. The wake is held back only when all of this holds: the task is `in_review` with a pending review stage, the wake would go to the stage reviewer, the author is the agent that handed the task over, the "Review CI wait" monitor is armed, and the head is not admitted yet (CI pending or unreadable, or the head is red). The comment stays in the thread and the reviewer reads it when the monitor wakes it; the board writes an `issue.review_comment_wake_deferred` activity row.
- Everything else wakes the reviewer as before: a person's comment, another agent's comment, an explicit resume, an @-mention, a critical task, a green head, and any comment after the reviewer was admitted (no armed monitor).
- The gate ships enabled. `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED=off` turns it off: every comment then wakes the assignee exactly as before.

## changelog-ru

### Комментарий исполнителя не будит ревьюера, пока стадия ревью ждёт зелёного CI (EMPTY-RUNS-2)

- Сдача на ревью проходит через ворота зелёного CI: пока `CI result` головы пул-реквеста не зелёный, ревьюера не будят, а доска ставит свой монитор «Review CI wait», который разбудит ревьюера, когда CI головы завершится. Путь комментария про ворота не знал: итоговая заметка исполнителя, отправленная отдельным запросом через секунды после сдачи, будила ревьюера причиной `issue_commented` в обход ворот. Прогон ревьюера видел незавершённый CI, не мог записать вердикт и заканчивался ещё одним комментарием. На доске выпуска (12–13.11.2026) 111 из 136 побудок ревьюеров комментарием вызваны комментарием инженера, 89 из них — при взведённом мониторе.
- Оба пути комментария (`POST /issues/:id/comments` и `PATCH /issues/:id` с комментарием) теперь применяют то же решение о допуске, что и смена статуса. Побудка придерживается, только когда выполнено всё сразу: задача в `in_review` с ожидающей стадией ревью, побудка адресована ревьюеру стадии, автор — агент, сдавший задачу, монитор «Review CI wait» взведён и голова ещё не допущена (CI идёт или не читается, либо голова красная). Комментарий остаётся в ленте, ревьюер прочтёт его при побудке от монитора; доска пишет в журнал запись `issue.review_comment_wake_deferred`.
- Всё остальное будит ревьюера как раньше: комментарий человека, комментарий другого агента, явное возобновление, упоминание через @, критичная задача, зелёная голова и любой комментарий после допуска ревьюера (монитор не взведён).
- Ворота включены по умолчанию. `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED=off` их выключает: тогда любой комментарий будит исполнителя, как раньше.

## divergence

| EMPTY-RUNS-2 | Побудка по комментарию проходит ворота допуска ревью по зелёному CI: комментарий исполнителя не будит ревьюера, пока взведён монитор «Review CI wait» и голова PR не допущена | `server/src/routes/issues.ts` (оба пути комментария, метка `myrmidon(EMPTY-RUNS-2)`); свой код: `server/src/myrmidon/review-stage-recovery/comment-wake-gate.ts` | 12–13.11: 111 из 136 побудок ревьюеров комментарием вызваны комментарием инженера, 89 — при взведённом мониторе; прогон ревьюера видел незавершённый CI и заканчивался комментарием | `server/src/__tests__/issue-comment-reopen-routes.test.ts` (блок `review comment wake gate`), `server/src/myrmidon/review-stage-recovery/comment-wake-gate.myrmidon.test.ts` | Когда вендор сам не будит участника стадии ревью комментарием исполнителя до допуска по CI — удалить вызовы `executorCommentHeldForReviewCi` и модуль ворот | (этот PR) |

## settings-en

| `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED` | EMPTY-RUNS-2 | unset (on) | The executor's comment on a task in review does not wake the reviewer while the board's "Review CI wait" monitor is armed and the pull request head is not admitted yet (CI pending or unreadable, or the head is red); the wake is recorded as `issue.review_comment_wake_deferred` and the monitor wakes the reviewer later. Comments of a person or of another agent, a critical task, a green head and any comment after the admission wake the reviewer as before | `off`, `0`, `false` or `no`: every comment wakes the assignee as before the gate |

## settings-ru

| `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED` | EMPTY-RUNS-2 | не задано (включено) | Комментарий исполнителя к задаче на ревью не будит ревьюера, пока взведён монитор доски «Review CI wait» и голова PR ещё не допущена (CI идёт или не читается, либо голова красная); придержанная побудка записывается как `issue.review_comment_wake_deferred`, ревьюера позже будит монитор. Комментарий человека или другого агента, критичная задача, зелёная голова и любой комментарий после допуска будят ревьюера как раньше | `off`, `0`, `false` или `no`: любой комментарий будит исполнителя, как до ворот |
