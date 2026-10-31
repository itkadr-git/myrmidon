## changelog-en

### The leader lease of the board: backend (PROCS-1.7 part A)

The board can now run as several processes against one database (design
OPE-5394 §5). This part delivers the protocol and the tables; the settings
panel that switches the mode is part B of the same task (OPE-5413).

- New tables: `board_processes` (one row per running process, refreshed by a
  10 s pulse; rows older than 2 min are reaped by the leader) and
  `board_leases` (`name` PK, `holder_boot_id`, `epoch`, `acquired_at`,
  `expires_at`) — migration 0388.
- The leader lease service (`server/src/services/leader-lease.ts`) implements
  the design §5.3 protocol: acquire as `INSERT … ON CONFLICT DO NOTHING`
  followed by `UPDATE … WHERE name=? AND (expires_at < clock_timestamp() OR
  holder_boot_id=me) RETURNING epoch`; the holder renews with the same UPDATE
  every TTL/3 (default TTL 30 s → every 10 s); a renewal that returns no row
  means the lease is lost and fires `onLost()` with an abort signal (design
  §5.4: the former leader stops its in-flight background passes and returns
  to the contender loop).
- The leader-only work is gated on the lease: the execution-control sweeps
  and the scheduled database backup check the lease before every pass. With
  the default (single-process) configuration nothing changes — the running
  process is the leader of everything and no lease rows are written.
- Graceful shutdown releases the leases right after the timers stop, so a
  standby takes over within one renewal tick (≤ 1 s); after kill -9 the lease
  expires and is taken over within the TTL (≤ 30 s by default).
- Every handover raises the «лидер сменился» attention signal (an
  activity-log entry) and publishes the `board.leader_changed` live event,
  so the panel sees the handover without restarting the board.
- The setting is `general.processes` (design §5.7: `{ mode: "single" |
  "split", apiCount, leaderLeaseTtlSec? }`), read live from the board UI —
  no restart needed. With the block absent the board behaves exactly as
  before.
- Read routes for the panel (part B): `GET /api/myrmidon/board-processes`
  and `GET /api/myrmidon/processes/leases`, answering the contract formats
  in `docs/myrmidon/board-leases-contract/*.json`.

Tests: unit coverage of acquire/renew/expire/release and the integration T2
(two contenders on one embedded Postgres: exactly one leader per lease,
handover on release ≤ 1 s, takeover after kill -9 within the TTL).

## changelog-ru

### Аренда лидера доски: backend (PROCS-1.7, часть A)

Доска умеет работать несколькими процессами над одной базой (design
OPE-5394 §5). Эта часть сдаёт протокол и таблицы; панель настроек,
переключающая режим, — часть B той же задачи (OPE-5413).

- Новые таблицы: `board_processes` (по строке на работающий процесс, пульс
  10 с; строки старше 2 мин чистит лидер) и `board_leases` (`name` PK,
  `holder_boot_id`, `epoch`, `acquired_at`, `expires_at`) — миграция 0388.
- Сервис аренды лидера (`server/src/services/leader-lease.ts`) реализует
  протокол §5.3: захват — `INSERT … ON CONFLICT DO NOTHING`, затем
  `UPDATE … WHERE name=? AND (expires_at < clock_timestamp() OR
  holder_boot_id=me) RETURNING epoch`; держатель продлевает тем же UPDATE
  каждые TTL/3 (по умолчанию TTL 30 с → каждые 10 с); неудачное продление
  (пустая выборка) означает потерю аренды и вызывает `onLost()` с сигналом
  остановки (§5.4: бывший лидер останавливает текущие проходы фоновых свипов
  и возвращается в цикл претендента).
- Лидерская работа закрыта арендой: свипы execution-control и плановый бэкап
  БД проверяют аренду перед каждым проходом. При конфигурации по умолчанию
  (один процесс) ничего не меняется — работающий процесс лидер всего, строки
  аренд не пишутся.
- При штатной остановке аренды освобождаются сразу после остановки таймеров,
  и резервный процесс захватывает их в течение одного тика продления (≤ 1 с);
  при kill -9 аренда истекает и перехватывается в пределах TTL (≤ 30 с по
  умолчанию).
- Каждая передача аренды поднимает сигнал внимания «лидер сменился» (запись в
  журнале активности) и публикует живое событие `board.leader_changed`, так
  что панель видит смену без перезапуска доски.
- Настройка — `general.processes` (design §5.7: `{ mode: "single" | "split",
  apiCount, leaderLeaseTtlSec? }`), читается на лету из интерфейса доски,
  перезапуск не нужен. Без этого блока доска ведёт себя ровно как раньше.
- Маршруты чтения для панели (часть B): `GET /api/myrmidon/board-processes`
  и `GET /api/myrmidon/processes/leases`, отвечают по контрактным форматам
  из `docs/myrmidon/board-leases-contract/*.json`.

Тесты: unit на захват/продление/истечение/release и интеграционный Т2 (два
претендента на одной встроенной Postgres: ровно один лидер на аренду,
передача при release ≤ 1 с, перехват после kill -9 в пределах TTL).
