## changelog-en

### Attention feed: the decision-retention state is written in the background, not on the read (1.6.5 F-15)

- `GET /api/companies/:id/attention` used to upsert the decision-retention
  rows that back the feed (`decision_retention`) inside the request, so every
  poll of the screen wrote to the database and the feed's own latency included
  those writes.
- The read path now only projects the state already stored (a read-only batch
  read) and parks the fresh snapshot in a per-company debounced scheduler. The
  retention sweep — the periodic pass that also runs auto-archive — drains the
  parked snapshots on the server's schedule: one pass per company at a time,
  at most one pass per company per 30 seconds, only the newest snapshot kept.
- A read never waits for the sync and never fails because of it: a failed
  background pass is logged and dropped, and the feed keeps rendering the
  state the previous pass stored until the next snapshot retried by the sweep
  succeeds.

## changelog-ru

### Лента «Внимание»: состояние хранения решений пишется в фоне, а не на чтении (1.6.5 F-15)

- `GET /api/companies/:id/attention` раньше обновлял строки хранения решений
  (`decision_retention`), на которых строится лента, прямо внутри запроса:
  каждый опрос экрана писал в базу, и эти записи входили в задержку самой
  ленты.
- Теперь чтение только проецирует уже сохранённое состояние (пакетное чтение
  без записи) и откладывает свежий снимок во фоновой планировщик
  синхронизации: по каждой компании хранится только самый свежий снимок.
  Подметальщик хранения — периодический проход, который также делает
  автоархивацию, — выгружает отложенные снимки по расписанию сервера:
  одновременно не больше одного прохода на компанию и не чаще одного прохода
  на компанию за 30 секунд.
- Чтение никогда не ждёт синхронизацию и не падает из-за неё: неудачный
  фоновый проход пишется в журнал и отбрасывается, а лента продолжает
  показывать состояние, сохранённое предыдущим проходом, пока повторная
  попытка не пройдёт успешно.

## settings-ru-append

<!-- section: Трек 2 — ядро побудок и прогонов -->
| `attentionFailedRunHorizonDays` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `7` | Горизонт в днях окна сбойных прогонов ленты «Внимание»: прогоны, исчерпавшие повторы и созданные раньше, чем «сейчас минус горизонт», не попадают в ленту, а поиск добивочного прогона ограничен `created_at > greatest(старейший сбойный прогон, now − horizon)` | От 1 до 365; нет значения или вне диапазона — умолчание. Без миграции и перезапуска |
| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `45` | Внутрипроцессный TTL собранного снимка ленты «Внимание» по компании. Записи (скрытие, решения) видны с задержкой до TTL | От 0 до 300; `0` — кэш выключен. Нет значения или вне диапазона — умолчание |
