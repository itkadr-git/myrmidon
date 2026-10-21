---
settings-section: Track 5 — operations
---

## changelog-en

### DEFERRED-WAKE-LEAK: close deferred wakes with terminal issues (OPE-8490)

- Deferred issue-execution wakeups are cancelled when an issue transitions to `done` or `cancelled`, including status-decision-driven transitions.
- A queued comment interrupt that is skipped because its issue is already terminal closes its source deferred wake, preventing repeated wake creation.

## changelog-ru

### DEFERRED-WAKE-LEAK: закрытие отложенных побудок вместе с задачей (OPE-8490)

- Отложенные побудки выполнения задачи отменяются при переходе задачи в `done` или `cancelled`, включая переходы через решение о статусе.
- Если queued comment interrupt пропущен из-за уже закрытой задачи, исходная отложенная побудка закрывается и повторное создание побудок прекращается.
