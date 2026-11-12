## changelog-en

### A full disk no longer leaves a bot answering 500 until restart (OPE-12759)

- When a write to the bot's run idempotency store failed on commit (for example, the bots disk was full), the store kept its database connection inside the failed transaction, and every later run request to that bot answered HTTP 500 until the bot container restarted. On 11.11 nine bots stayed down for 15 hours this way after the disk filled up. The store now rolls back a failed write, and rolls back a transaction left open before starting the next one, so the bot recovers by itself once space is back.

## changelog-ru

### Переполненный диск больше не оставляет бота с ответом 500 до перезапуска (OPE-12759)

- Если запись в хранилище идемпотентности прогонов бота падала при фиксации (например, кончилось место на диске ботов), хранилище оставляло соединение внутри неудавшейся транзакции, и каждый следующий запрос прогона к этому боту получал HTTP 500 до перезапуска контейнера. 11.11 так 15 часов простояли девять ботов после заполнения диска. Теперь хранилище откатывает неудачную запись и откатывает оставшуюся открытой транзакцию перед следующей — бот восстанавливается сам, как только место освобождается.
