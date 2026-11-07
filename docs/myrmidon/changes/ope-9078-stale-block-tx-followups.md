---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Stale-block watchdog: live events publish after commit, locked recheck stays on the transaction

- The activity events written when the watchdog lifts a dead block are now published only after
  the transaction commits, so a rollback can no longer leave the UI with an event that never
  happened.
- The recovery-liveness check made under the issue lock now reads through the same transaction
  connection instead of taking a second one.

## changelog-ru

### Сторож блокировок: live-события уходят после commit, перепроверка под замком идёт через транзакцию

- События activity, которые пишутся при снятии мёртвой блокировки, теперь публикуются только после
  commit транзакции: откат больше не оставляет в интерфейсе событие, которого не было.
- Проверка recovery-liveness под замком задачи теперь читает через то же соединение транзакции,
  а не занимает второе.
