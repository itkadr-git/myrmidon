---
divergence-section: 1.6.5 — PROCS-Q2 (часть B): CAS запуска cron-задач плагинов
---

## changelog-en

### Plugin cron job launches are captured with a database CAS (PROCS-Q2 part B)

A plugin job fired by the scheduler is now claimed atomically before it runs:
`UPDATE plugin_jobs SET status='running' WHERE id=? AND status<>'running'
RETURNING`. Only the caller whose statement returns the row dispatches the
worker; every other concurrent tick — a second scheduler process, or a
double pass of the same tick — receives no row and skips the launch as a
normal, silent outcome (not an error). This closes the double-execution race
for plugin cron jobs under the multi-process board (OPE-5394 §4, §5.5).

The capture is released in the same dispatch path after the run reaches a
terminal state and the schedule pointer has advanced, so no process can
re-dispatch with a stale `nextRunAt`. The release is conditional on the job
still being `running`: an operator pause recorded mid-run is never clobbered
back to `active` by a finishing run. `running` joins the job status enum as a
transient, host-managed state: `GET /plugins/:id/jobs?status=running` can
filter on it, but it remains non-settable through the API (pause/resume still
accept only `active`/`paused`/`failed`). Default single-process behaviour is
unchanged apart from the guard itself. A capture left behind by a process
that died mid-run is reclaimed back to `active` by the scheduler tick once it
is older than two job timeouts, so a crashed owner can never wedge a job.
Covered by an embedded-Postgres test:
two scheduler instances ticking the same due job produce exactly one worker
execution and one run row.

## changelog-ru

### Запуск cron-задач плагинов захватывается CAS-ом на уровне БД (PROCS-Q2 ч.B)

Задача плагина перед запуском атомарно захватывается в БД: `UPDATE plugin_jobs
SET status='running' WHERE id=? AND status<>'running' RETURNING`. Worker
запускает только тот, чей UPDATE вернул строку; любой параллельный тик —
второй процесс планировщика или двойной проход того же тика — строку не
получает и пропускает запуск как штатный исход (не ошибка). Это закрывает
гонку двойного выполнения cron-задач плагинов при многопроцессной доске
(OPE-5394 §4, §5.5).

Захват освобождается в том же пути диспетчеризации после терминального
состояния запуска и продвижения указателя расписания — повторно запустить
задачу по устаревшему `nextRunAt` невозможно. Освобождение условно: если
оператор поставил pause во время выполнения, завершающийся запуск не вернёт
задачу в `active`. Значение `running` добавлено в статусы задач как
транзиентное, подотчётное планировщику: фильтровать `?status=running` можно,
задать вручную по-прежнему нельзя (pause/resume принимают только
`active`/`paused`/`failed`). Захват, оставшийся умершим в середине запуска
процессом, возвращается в `active` тиком планировщика, если старше двух
таймаутов задачи — зависшая задача не блокируется навсегда. Поведение по
умолчанию не меняется. Тест на встроенном Postgres: два планировщика на одной due-задаче
дают ровно одно выполнение worker-а и одну строку запуска.
