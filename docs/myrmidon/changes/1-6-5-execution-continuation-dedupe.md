---
---

## changelog-en

### Migration 0380 removes the historical executionContinuation duplicates from run snapshots

- `heartbeat_runs.context_snapshot` keeps one copy of the `executionContinuation`
  envelope: the top-level key. Rows written before the single-copy writer also
  carry a nested duplicate in `paperclipWake.executionContinuation`. Migration
  `0380` removes the nested duplicate in primary-key batches of 200 rows. A row
  that has the envelope only in the nested place (written by an external adapter
  under the old contract) gets it lifted to the top level first, so the read
  path keeps seeing it. A second run changes nothing. The migration is heavy on
  the production database: apply it in a maintenance window.

## changelog-ru

### Миграция 0380 убирает исторические дубли executionContinuation из снимков прогонов

- В `heartbeat_runs.context_snapshot` конверт `executionContinuation` хранится
  одной копией — ключом верхнего уровня. Строки, записанные до писателя с одной
  копией, ещё несут вложенный дубль `paperclipWake.executionContinuation`.
  Миграция `0380` снимает вложенный дубль пачками по 200 строк по первичному
  ключу. Если конверт лежит только во вложенном месте (его писал внешний адаптер
  по старому контракту), его сначала поднимают наверх, чтобы путь чтения его
  по-прежнему видел. Повторный прогон ничего не меняет. На боевой базе миграция
  тяжёлая: применять в окне обслуживания.
