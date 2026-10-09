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
  каждый опрос экрана писал в базу, и эти записи удлиняли ответ самой ленты.
- Теперь чтение только отдаёт уже сохранённое состояние (пакетное чтение без
  записи), а свежий снимок откладывает в фоновый планировщик синхронизации:
  по каждой компании хранится только самый свежий снимок. Подметальщик
  хранения — периодический проход, который разбирает отложенные снимки по
  расписанию сервера и заодно выполняет автоархивацию: одновременно не
  больше одного прохода на компанию и не чаще одного раза в 30 секунд.
- Чтение никогда не ждёт синхронизацию и не завершается ошибкой из-за неё:
  неудачный фоновый проход записывается в журнал и отбрасывается, а лента
  продолжает показывать состояние, сохранённое предыдущим проходом, пока
  повторная попытка не завершится успешно.

## settings-ru-append

<!-- section: Трек 2 — ядро побудок и прогонов -->
| `attentionFailedRunHorizonDays` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `7` | Горизонт окна сбойных прогонов ленты «Внимание», в днях: прогоны, у которых закончились повторы и которые старше горизонта, в ленту не попадают, а поиск повторного прогона ограничен `created_at > greatest(старейший сбойный прогон, now − horizon)` | От 1 до 365; значение вне диапазона зажимается к границе, нет значения — умолчание. Без миграции и перезапуска |
