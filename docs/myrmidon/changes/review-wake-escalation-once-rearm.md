## changelog-en

### An exhausted review wake series is escalated once and re-armed after 6 hours (REVIEW-ROUTING, OPE-11947)

- The review routing sweep wakes the reviewer of a stage on a bounded backoff (`REVIEW_WAKE_MAX_ATTEMPTS`, 6 attempts, each one recorded in the activity log with its `attempt` number). When the model pools were empty all six attempts burned at once; after that every pass (once a minute) wrote a new `issue.review_routing.wake_escalation_required` row for the stage (7 202 rows in a day on the production board) and never woke the reviewer again, so the stage stayed stuck until someone replayed the wake by hand.
- The escalation is now written once per exhausted series: a `wake_escalation_required` row of the same task, reviewer and stage that is newer than the last wake means the series was already escalated, and the warning is not repeated either.
- A series exhausted for at least `REVIEW_WAKE_REARM_AFTER_MS` (6 hours since its last attempt) is re-armed: the next wake is recorded with `attempt` 1 and the backoff counts from the start of the new series. A stage stuck behind an unavailable model comes back on its own within 6 hours instead of never; the earlier escalation stays in the log as a fact. The backoff inside a series, the one-wake-per-pass limit and the cancelled-run anchor are unchanged.

## changelog-ru

### Исчерпанная серия побудок ревьюера эскалируется один раз и взводится заново через 6 часов (REVIEW-ROUTING, OPE-11947)

- Подметальщик маршрутизации ревью будит ревьюера этапа с ограниченным бэкоффом (`REVIEW_WAKE_MAX_ATTEMPTS`, 6 попыток, каждая пишется в журнал активности с номером `attempt`). Когда пулы моделей были пусты, все шесть попыток сгорали впустую; после этого каждый проход (раз в минуту) писал новую строку `issue.review_routing.wake_escalation_required` по этапу (7 202 строки за сутки на боевой доске) и больше никогда не будил ревьюера, так что этап стоял, пока кто-нибудь не повторял побудку вручную.
- Эскалация теперь пишется один раз на исчерпанную серию: строка `wake_escalation_required` по той же задаче, ревьюеру и этапу, новее последней побудки, означает, что серия уже эскалирована; предупреждение в лог тоже не повторяется.
- Серия, исчерпанная не менее `REVIEW_WAKE_REARM_AFTER_MS` (6 часов с её последней попытки), взводится заново: следующая побудка пишется с `attempt` 1, бэкофф идёт с начала новой серии. Этап, застрявший на недоступной модели, возвращается сам не позже чем через 6 часов, а не никогда; прежняя эскалация остаётся в журнале как факт. Бэкофф внутри серии, лимит одной побудки за проход и привязка к отменённому прогону не изменены.
