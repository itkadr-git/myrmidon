## changelog-en

### OPE-12557: advisory-lock transactions no longer exhaust the database pool

- Wake-queue release runs its host callbacks on the release transaction's connection instead of taking a second pool connection while it holds the lock.
- At most two locked conversation deliveries run at once per process; the others wait without holding a connection. On 10.11 all 12 pool connections were taken by transactions waiting for each other after `pg_advisory_xact_lock` and the board stopped.

## changelog-ru

### OPE-12557: транзакции с advisory-замком больше не исчерпывают пул соединений

- Освобождение очереди побудок выполняет колбэки хоста на соединении своей транзакции, а не берёт второе соединение из пула, держа замок.
- Одновременно в процессе идут не больше двух доставок сообщений диалога под замком; остальные ждут, не держа соединения. 10.11 все 12 соединений пула заняли транзакции, ждавшие друг друга после `pg_advisory_xact_lock`, и доска вставала.
