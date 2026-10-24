---
settings-section: Track 5 — operations
---

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
- Every attempt is a row of the new table `myrmidon_fleet_memory_syncs` (migration 0416): site,
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

## settings-en

| `MYRMIDON_FLEET_MEMORY_SYNC` | C-MEM | unset (off) | Turns on the memory sync of execution sites: the nightly lane `myrmidon-memory-sync` copies each site's work-memory bank into the replica bank of the board's hindsight, and a live bot move runs a forced sync after the source stops. Needs `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL` and the site-health lane (`MYRMIDON_SITE_HEALTH=1`) | Unset or anything but `1` — nothing syncs. Switch it on only after the production import (P5) of the site's memory |
| `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL` / `MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN` | C-MEM | unset | Address (and optional bearer token) of the board's hindsight that the sync imports into | Without the address the sync is not built (a warning is logged) |
| `MYRMIDON_FLEET_MEMORY_REPLICA_BANK` | C-MEM | `fleet-work-replica` | The replica bank the sync merges into (must exist) | Unset — the default bank |
| `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC` | C-MEM | `20` | The UTC hour after which a site's nightly sync is due; a failed attempt is retried every 15 minutes | Not an integer 0-23 — the default |

## settings-ru

| `MYRMIDON_FLEET_MEMORY_SYNC` | C-MEM | не задан (выкл.) | Включает синхронизацию памяти площадок исполнения: ночная lane `myrmidon-memory-sync` копирует банк рабочей памяти каждой площадки в банк реплики hindsight доски, а живой переезд бота запускает принудительную синхронизацию после остановки источника. Нужны `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL` и lane здоровья площадок (`MYRMIDON_SITE_HEALTH=1`) | Не задан или не `1` — ничего не синхронизируется. Включать только после боевого импорта (П5) памяти площадки |
| `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL` / `MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN` | C-MEM | не задан | Адрес (и необязательный Bearer-токен) hindsight доски, куда синхронизация импортирует | Без адреса синхронизация не создаётся (в журнал пишется предупреждение) |
| `MYRMIDON_FLEET_MEMORY_REPLICA_BANK` | C-MEM | `fleet-work-replica` | Банк реплики, в который сливается память (должен существовать) | Не задан — банк по умолчанию |
| `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC` | C-MEM | `20` | Час UTC, после которого наступает ночная синхронизация площадки; неудачная попытка повторяется каждые 15 минут | Не целое 0-23 — значение по умолчанию |
