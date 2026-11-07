## changelog-en

### A review task with a live review participant is no longer escalated to board-only blocked (REVIEW-PARTICIPANT-LIVE-SKIP)

- The stranded-assigned-work reconciliation no longer moves an `in_review` task into board-only `blocked` while the typed review participant of the execution-review stage has a live run — a run in an execution status on **any** issue of the company, not only the task being reconciled.
- Before the escalation branch (policy `board_escalation_no_takeover_v1`) runs, the new helper `getLatestLiveRunForAgent` looks up the participant's latest live run across the company; a found live run skips both the board escalation and the participant's adapter-failure classification. The task keeps waiting for its live participant instead of receiving a board card.
- Shipped earlier (merge of the fix predates the 1.6.5 cut); this entry closes the missing changelog record. See DIVERGENCE.md, `REVIEW-PARTICIPANT-LIVE-SKIP`.

## changelog-ru

### Задача на ревью с живым участником больше не уходит в board-only blocked (REVIEW-PARTICIPANT-LIVE-SKIP)

- Разбор зависших назначенных задач больше не переводит задачу в `in_review` в board-only `blocked`, пока у типизированного участника review-стадии есть живой прогон — прогон в статусе исполнения по **любому** тикету компании, не только по разбираемой задаче.
- Перед веткой эскалации (политика `board_escalation_no_takeover_v1`) новый helper `getLatestLiveRunForAgent` ищет последний живой прогон участника по всей компании; найденный живой прогон пропускает и эскалацию к доске, и разбор adapter-отказа участника. Задача ждёт живого участника вместо карточки доске.
- Изменение поехало раньше (слияние фикса предшествует срезу 1.6.5); эта запись закрывает пропуск в журнале. См. DIVERGENCE.md, `REVIEW-PARTICIPANT-LIVE-SKIP`.
