---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Fix: chat reconciliation work gates failed on every call (DB-PERF-C-P5)

- The cheap work gates bound a JavaScript `Date` as a parameter inside raw
  `sql` templates (`next_attempt_at <= $1`, `updated_at > $1`), which the
  postgres-js driver cannot serialise. Every gate probe threw, so the log
  filled with `Failed to reconcile chat run milestones` and `Failed to
  reconcile chat publications` roughly every 30 seconds. Timestamps are now
  bound as ISO strings with an explicit `::timestamptz` cast. A regression test
  runs the gates against a real PostgreSQL.

## changelog-ru

### Исправление: «дешёвые гейты» сверки чатов падали на каждом вызове (DB-PERF-C-P5)

- Гейты передавали объект `Date` параметром в сырых `sql`-шаблонах
  (`next_attempt_at <= $1`, `updated_at > $1`); драйвер postgres-js такое не
  сериализует. Каждая проверка бросала ошибку, и в журнале примерно раз в 30 с
  появлялись `Failed to reconcile chat run milestones` и `Failed to reconcile
  chat publications`. Теперь время передаётся ISO-строкой с явным приведением
  `::timestamptz`. Регрессионный тест гоняет гейты на настоящем PostgreSQL.
