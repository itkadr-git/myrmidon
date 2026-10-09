---
divergence-section: 1.6.6 — PROCS-0.1: панель «Процессы» и таблица board_processes
---

## changelog-en

### Board processes: the registry table, the pulse, and the «Processes» panel (PROCS-0.1)

Every board process now owns one row in the new `board_processes` table
(migration 0311): `boot_id` (primary key), `role`, `pid`, `hostname`, `container`,
`version`, `started_at`, `last_seen_at`, `api_port`, `event_loop_lag_ms`, `rss_bytes`.
The row is inserted at boot and re-pulsed every 10 seconds with the moving parts
(`last_seen_at`, the event-loop p99 delay in ms, the RSS). Rows whose pulse went
quiet are deleted after two minutes; when several processes share the database, an
advisory try-lock makes exactly one of them run the sweep per turn.

Instance settings gained the **Processes** page (`instance.processes`, hidden-page
gated like the rest of the instance settings): a table of the live board processes
with their role, boot id, pulse age, event-loop lag, RSS, pid, host/container,
version and start time, refreshed every 10 seconds.

The Prometheus exposition gained `myrmidon_board_event_loop_utilization` (the
`performance.eventLoopUtilization` delta between reads) and the process families
(`myrmidon_board_event_loop_lag_seconds`, `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes`, the utilization) now carry `role`/`boot` labels that
match the process's `board_processes` row, so a multi-process board can be told
apart per replica.

The default (`role=single`) behaviour is unchanged: one process, one row, one
sweeper. Nothing is configured — the panel and the pulse are always on.

## changelog-ru

### Процессы доски: таблица-реестр, пульс и панель «Процессы» (PROCS-0.1)

Каждый процесс доски владеет одной строкой новой таблицы `board_processes`
(миграция 0311): `boot_id` (первичный ключ), `role`, `pid`, `hostname`, `container`,
`version`, `started_at`, `last_seen_at`, `api_port`, `event_loop_lag_ms`, `rss_bytes`.
Строка вставляется при запуске и перезаписывается каждые 10 секунд подвижными
частями (`last_seen_at`, p99 задержки цикла событий в мс, RSS). Строки, чей пульс
замолчал, удаляются через две минуты; когда базу делят несколько процессов,
advisory try-lock оставляет ровно одного «уборщика» на такт.

В настройках инстанса появилась страница **«Процессы»** (`instance.processes`,
скрываемая как остальные страницы настроек инстанса): таблица живых процессов
доски с ролью, boot id, возрастом пульса, задержкой цикла событий, RSS, pid,
хостом/контейнером, версией и временем старта; обновление — раз в 10 секунд.

Экспозиция Prometheus дополнилась `myrmidon_board_event_loop_utilization` (дельта
`performance.eventLoopUtilization` между чтениями), а семейства процесса
(`myrmidon_board_event_loop_lag_seconds`, `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes`, utilization) получили метки `role`/`boot`, совпадающие
со строкой процесса в `board_processes`, — реплики многопроцессной доски различимы
по отдельности.

Поведение по умолчанию (`role=single`) не меняется: один процесс, одна строка,
один уборщик. Ничего не настраивается — панель и пульс включены всегда.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| 1.6.6-PROCS-0.1 | Таблица `board_processes` (миграция 0311) + пульс процесса раз в 10 с (сервис `board-processes.ts`) + advisory-уборка строк старше 2 мин; страница «Процессы» в Instance settings; метрика `myrmidon_board_event_loop_utilization`; метки `role`/`boot` на семействах процесса | `packages/db/src/schema/board_processes.ts`, `packages/db/src/migrations/0311_board_processes.sql`, `server/src/services/board-processes.ts`, `server/src/routes/board-processes.ts`, `server/src/myrmidon/monitoring/metrics/process-metrics.ts`, `server/src/myrmidon/monitoring/metrics/metrics.ts`, `server/src/myrmidon/monitoring/metrics/routes.ts`, `ui/src/pages/InstanceProcesses.tsx`, `ui/src/components/CompanySettingsSidebar.tsx`, `ui/src/App.tsx` | Этап 0 проекта «несколько процессов доски» (OPE-5394 §5.1): без реестра живых процессов и их метрик в интерфейсе нельзя включать роли api/scheduler; панель — единственное место, где оператор видит процессы без ps | `server/src/services/board-processes.test.ts` (пульс, upsert, advisory-уборка, stop), `packages/db/src/board-processes-migration.myrmidon.test.ts` (форма миграции), `server/src/myrmidon/monitoring/metrics/exposition.myrmidon.test.ts` + `routes.myrmidon.test.ts` (новая метрика и метки в экспозиции) | Удалить миграцию, сервис, роут, страницу и метки; метрики возвращаются к форме 1.6.5-PROCS-Q3 | — |
