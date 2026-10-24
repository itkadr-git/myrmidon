## changelog-en

### Async writer acquire keeps synchronous callers compatible

- Delta 18 preserves synchronous `SessionDB` callers while moving deferred gateway writer acquisition off the event loop. Its awaited transaction performs the complete sidecar scan before connecting, rejects incomplete or held verdicts, and preserves registry ownership, cancellation cleanup, recovery retries, and shutdown drain.
- The Docker image applies `18-async-writer-acquire.patch` at the pinned Hermes source. Lifecycle behavior is covered by the Hermes regression tests carried in the delta and Myrmidon builder checks.

## changelog-ru

### Async writer acquire сохраняет синхронные вызовы

- Дельта 18 сохраняет синхронных клиентов `SessionDB`, перенося отложенное получение writer-соединения gateway за пределы event loop. Awaited-транзакция выполняет полный scan sidecar до подключения, запрещает подключение при неполном результате или holder и сохраняет владение реестром, очистку после отмены, повторы восстановления и drain при shutdown.
- Docker-образ применяет `18-async-writer-acquire.patch` к закреплённой версии Hermes. Поведение lifecycle покрыто регрессионными Hermes-тестами в дельте и проверками Myrmidon builder.
