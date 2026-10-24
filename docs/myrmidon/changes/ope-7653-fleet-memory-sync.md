<!-- bot/OPE-7653 — 1.6.6 C-MEM: journal and nightly lane of the site memory sync -->

## changelog-en

### Work-memory of an execution site is replicated to the board (1.6.6)

- The memory of a remote site stays on the site (its own hindsight): its bots recall and retain
  there and do not depend on the link to the board. The board keeps a replica of it in the
  `fleet-work-replica` bank.
- New lane `myrmidon-memory-sync`: once a night (after `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC`, 20 by
  default) the board asks the site-agent for the bank export (`POST /v1/memory/export`) and merges
  it into the replica bank (`transfer/import`, `mode=merge`, `document_conflict=skip`, so a
  repeated or resumed sync never duplicates a document). A failed attempt is retried on every
  tick (every 15 minutes) until one succeeds.
- Every attempt is a row of the new table `myrmidon_fleet_memory_syncs` (migration 0415): site,
  kind (`nightly`, `forced`, `manual`), status, archive size, imported/skipped documents, error.
- A live bot move runs a forced sync right after the source container is stopped. It is bounded
  (5 minutes) and best effort: a failure is journaled and the move goes on.
- Opt-in: `MYRMIDON_FLEET_MEMORY_SYNC=1` and `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL`
  (`MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN`, `MYRMIDON_FLEET_MEMORY_REPLICA_BANK` are optional).
  The lane runs inside the site-health lane (`MYRMIDON_SITE_HEALTH=1`).

## changelog-ru

### Рабочая память площадки исполнения реплицируется на доску (1.6.6)

- Память удалённой площадки остаётся на площадке (собственный hindsight): её боты вспоминают и
  записывают там и не зависят от связи с доской. Доска держит реплику в банке
  `fleet-work-replica`.
- Новая lane `myrmidon-memory-sync`: раз в ночь (после часа `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC`,
  по умолчанию 20) доска просит у site-agent выгрузку банка (`POST /v1/memory/export`) и вливает
  её в банк реплики (`transfer/import`, `mode=merge`, `document_conflict=skip`: повторная или
  дозапущенная синхронизация не дублирует документы). Неудачная попытка повторяется на каждом
  тике (раз в 15 минут), пока одна не пройдёт.
- Каждая попытка — строка новой таблицы `myrmidon_fleet_memory_syncs` (миграция 0415): площадка,
  вид (`nightly`, `forced`, `manual`), статус, размер архива, импортировано/пропущено документов,
  ошибка.
- Перед живым переездом бота, сразу после остановки исходного контейнера, выполняется
  принудительная синхронизация. Она ограничена по времени (5 минут) и не блокирует: сбой
  записывается в журнал, переезд продолжается.
- Включается явно: `MYRMIDON_FLEET_MEMORY_SYNC=1` и `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL`
  (`MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN`, `MYRMIDON_FLEET_MEMORY_REPLICA_BANK` — по желанию).
  Lane работает внутри lane здоровья площадок (`MYRMIDON_SITE_HEALTH=1`).
