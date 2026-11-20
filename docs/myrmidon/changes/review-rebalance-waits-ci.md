## changelog-en

### A review that was already read on the current PR head and waits only for its CI is no longer rebalanced to another reviewer (REVIEW-REBALANCE-CI)

- On 16.11 (1.6.9) the review-queue rebalance passed a review to another reviewer every 30 minutes even when the current
  reviewer had already read the current head of the pull request and the review was only waiting for CI. In one task
  (OPE-13182, PR #3270, CI cancelled on the head) this made 12 handoffs and 11 review runs in 6 hours: each reviewer wrote
  "no new blocking remarks" and could not approve without a green CI, then the review moved on.
- The rebalance now skips such a review. "Already read" means a succeeded run of the current reviewer on the task started, or the reviewer wrote a
  comment, after the last change of the pull request head (when the head never changed on the board, after the review was
  routed to them). "Waits for CI" means the board's own CI reader (the one the review wake and the verdict check use) reports
  the `CI result` of the current head as not finished. One line per task, reviewer and head goes to the server log.
- A review the reviewer has not started on the current head is rebalanced as before. When CI finishes, the review goes the
  usual way (the CI-completed event wakes the reviewer). If the CI reader fails, the rebalance goes on as before.
- No migration and no new settings.

## changelog-ru

### Ревью, уже прочитанное на текущей голове PR и ждущее только CI, больше не перебрасывается другому ревьюеру (REVIEW-REBALANCE-CI)

- 16.11 (1.6.9) перебалансировка очереди ревью каждые 30 минут передавала ревью другому ревьюеру, даже когда текущий
  ревьюер уже прочитал текущую голову pull request, а ревью ждало только CI. На одной задаче (OPE-13182, PR #3270, CI на
  голове отменён) за 6 часов вышло 12 перебросок и 11 прогонов ревью: каждый ревьюер писал «новых блокирующих замечаний
  нет», не мог одобрить без зелёного CI, и ревью уходило дальше.
- Теперь перебалансировка такое ревью пропускает. «Уже прочитано» — успешный прогон текущего ревьюера по задаче начался или ревьюер оставил
  комментарий после последней смены головы PR (если голова на доске не менялась — после того, как ревью передано ему).
  «Ждёт CI» — собственное чтение CI на доске (то же, что у будящего сигнала ревью и проверки вердикта) показывает, что
  `CI result` текущей головы не завершён. В журнал сервера пишется одна строка на задачу, ревьюера и голову.
- Ревью, которое ревьюер на текущей голове не начинал, перебрасывается как раньше. Когда CI завершится, ревью идёт обычным
  путём (событие завершения CI будит ревьюера). Если прочитать CI не удалось, перебалансировка идёт как раньше.
- Без миграций и без новых настроек.
