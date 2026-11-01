## changelog-en

### Transactional outbox for governed secret-proposal resolution (OPE-10061 / OPE-3061 / OPE-3078)

- Governed approval and rejection via `markProposalInteractionResolution` writes an interaction continuation outbox intent inside the resolution transaction for `continuation_policy wake_assignee` and `wake_assignee_on_accept`.
- Guaranteed delivery via periodic outbox sweep on direct enqueue failure.
- Deterministic idempotency key (`interaction:<interactionId>:<status>`) for `secret_proposal_resolved` to prevent duplicate wakeups and double launches.
- Continuation policies outside resolution scope (`none`, or `wake_assignee_on_accept` on reject) skip outbox recording and wakeup dispatch.

## changelog-ru

### Транзакционный outbox для governed secret-proposal resolution (OPE-10061 / OPE-3061 / OPE-3078)

- Согласование/отклонение секретных предложений через `markProposalInteractionResolution` атомарно записывает outbox intent продолжения взаимодействия в транзакции резолюции для `continuation_policy wake_assignee` и `wake_assignee_on_accept`.
- Обеспечена гарантированная доставка через штатный периодический sweep при сбое прямой очереди (enqueue failure).
- Детерминированный ключ идемпотентности (`interaction:<interactionId>:<status>`) для `secret_proposal_resolved` без повторных запусков и двойных пробуждений.
- Политики вне области действия (`none` или `wake_assignee_on_accept` при отклонении) исключены из записи outbox и пробуждения.
