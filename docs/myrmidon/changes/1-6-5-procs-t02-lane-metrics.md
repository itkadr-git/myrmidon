---
divergence-section: 1.7 — METRICS: собственные метрики доски в формате Prometheus (часть A)
---

## changelog-en

### Board lane metrics: DB queries and busy seconds per line of work (PROCS-T02)

`GET /metrics` answers two more families: `myrmidon_board_db_queries_total{lane}`
and `myrmidon_board_lane_busy_seconds_total{lane}` — the DB queries and the wall
seconds each line of the board's work spent since boot. The lanes are `tick` (a
scheduler tick), `execution-control` (the sweeps of the execution queues),
`chat-reconcile`, `bot-reconcile`, the API request handlers — and `unlabeled`
for everything running outside them.

The label is an `AsyncLocalStorage` value, the counters an in-process map beside
the live-event counters of the process half, and the query count comes from one
small wrapper around the client `createDb` hands to drizzle: the postgres.js
driver offers no per-query hook, so the wrapper counts the queries the ORM issues
on that client (including the ones inside a transaction it opened). No new
endpoint, no setting, no migration, and nothing that can fail a query: the
accounting is a listener that never throws.

Single-process behaviour is unchanged: work that runs outside every lane counts
as `unlabeled`, and both families appear only once the process has something to
report. This is the measurement half that этап 0 of the multi-process project
still owed — which line of the board writes to the database and how long it
occupies the event loop.

## changelog-ru

### Метрики линий доски: запросы к БД и занятое время по линиям работы (PROCS-T02)

`GET /metrics` отвечает двумя новыми семействами: `myrmidon_board_db_queries_total{lane}`
и `myrmidon_board_lane_busy_seconds_total{lane}` — запросы к БД и секунды работы,
которые каждая линия доски потратила с запуска процесса. Линии: `tick` (тик
планировщика), `execution-control` (свипы очередей исполнения), `chat-reconcile`,
`bot-reconcile`, обработчики API-запросов — и `unlabeled` для всего, что идёт вне них.

Метка — значение `AsyncLocalStorage`, счётчики — карта в памяти рядом со счётчиками
live-событий процессной половины, а число запросов даёт один небольшой слой вокруг
клиента, который `createDb` отдаёт drizzle: у драйвера postgres.js нет хука на запрос,
поэтому слой считает запросы, которые ORM шлёт через этот клиент (включая запросы
внутри открытой им транзакции). Нового эндпоинта, настройки и миграции нет, и запрос
от учёта упасть не может: слушатель не бросает исключений.

Поведение одиночного процесса не меняется: работа вне любой линии считается как
`unlabeled`, а оба семейства появляются только когда процессу есть что показать.
Это вторая измерительная половина этапа 0 проекта «несколько процессов доски» —
какая линия доски пишет в базу и сколько времени занимает цикл событий.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| 1.6.5-PROCS-T02 | К экспозиции `/metrics` добавлены два семейства по линиям работы (метка AsyncLocalStorage): число запросов к БД и занятые секунды по линиям `tick`, `execution-control`, `chat-reconcile`, `bot-reconcile`, `api`; учёт запросов — слой вокруг клиента в `packages/db` (у драйвера нет хука на запрос) | `server/src/myrmidon/monitoring/metrics/lane-context.ts`, `server/src/myrmidon/monitoring/metrics/lane-metrics.ts`, `server/src/myrmidon/monitoring/metrics/process-metrics.ts`, `server/src/myrmidon/monitoring/metrics/metrics.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/src/myrmidon/bot-containers/index.ts`, `packages/db/src/myrmidon-query-accounting.ts`, `packages/db/src/client.ts` | Этап 0 проекта «несколько процессов доски» (design §8, вопрос П2): решение о выносе фоновых линий в отдельные процессы невозможно без замера их запросов и занятого времени; метрики живут в существующей экспозиции, а не в новом эндпоинте | `server/src/myrmidon/monitoring/metrics/lane-context.myrmidon.test.ts` (вложенность, дефолт `unlabeled`, восстановление после await и исключения), `server/src/myrmidon/monitoring/metrics/lane-metrics.myrmidon.test.ts` (занятые секунды по линиям, учёт запроса в линию под `withLane`, `unlabeled` вне контекста, учёт внутри транзакции), `server/src/myrmidon/monitoring/metrics/exposition.myrmidon.test.ts` (семейства и образцы в экспозиции, пустое состояние без образцов), `server/src/myrmidon/monitoring/metrics/process-metrics.myrmidon.test.ts` (семь процессных семейств при сбое чтения) | Убрать два семейства из METRIC_FAMILIES/рендеринга и `lane-metrics.ts` вместе с вызовами `runInLane`; слой учёта в `packages/db` снимается вместе с вызовом в `createDb` | — |