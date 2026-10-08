---
divergence-section: 1.7 — METRICS: собственные метрики доски в формате Prometheus (часть A)
---

## changelog-en

### Board process metrics: event loop delay, memory, live-event flow (PROCS-Q3)

`GET /metrics` now answers five more families: `myrmidon_board_event_loop_lag_seconds`
(p50/p99/max summary, measured between scrapes), `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes` (used/total), `myrmidon_board_live_events_total` and
`myrmidon_board_live_event_bytes_total` (per live-event kind, cumulative since boot).
This is the measurement half of этап 0 of the multi-process project: no scaling of the
board may be argued without these numbers first.

Nothing new stores or configures: the delay comes from Node's `monitorEventLoopDelay`
(read-and-reset, so a quantile describes exactly the scrape interval), the memory from
`process.memoryUsage()`, and the live-event flow from an ordinary subscriber of the
existing `services/live-events.ts` emitter — the publisher is not modified. The
observers start lazily on the first authorized scrape, so an endpoint nobody scrapes
costs nothing. A failing process read zeroes the five families by name in
`myrmidon_scrape_errors` and never kills the scrape, exactly as the DB families already
behave. Measured overhead of the per-event listener (Node 24, 100k events with JSON
payload serialization through the real `recordLiveEvent` path): **0.85 µs per event**,
85 ms total — at a sustained 1000 events/second that is 0.085 % of one CPU core, an
order of magnitude below the 1 % budget.

## changelog-ru

### Метрики процесса доски: задержка цикла событий, память, поток live-событий (PROCS-Q3)

`GET /metrics` отвечает пятью новыми семействами: `myrmidon_board_event_loop_lag_seconds`
(summary p50/p99/max, измеряется между скрейпами), `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes` (used/total), `myrmidon_board_live_events_total` и
`myrmidon_board_live_event_bytes_total` (по типу live-события, накопительно с запуска).
Это измерительная половина этапа 0 проекта «несколько процессов доски»: без этих чисел
любое решение о масштабировании необоснованно.

Ничего нового не хранится и не настраивается: задержка берётся из
`monitorEventLoopDelay` Node (чтение-со-сбросом — квантиль описывает ровно интервал
между скрейпами), память — из `process.memoryUsage()`, поток live-событий — из обычного
подписчика существующего эмиттера `services/live-events.ts`; сам публикатор не изменён.
Наблюдатели стартуют лениво при первом авторизованном скрейпе — эндпоинт, который никто
не скрейпит, не стоит ничего. Сбой чтения процесса обнуляет пять семейств по имени в
`myrmidon_scrape_errors` и не убивает скрейп — как уже ведут себя DB-семейства.
Замеренные накладные расходы слушателя (Node 24, 100 тыс. событий с сериализацией
payload через реальный `recordLiveEvent`): **0,85 мкс на событие**, 85 мс суммарно —
при устойчивых 1000 событиях/с это 0,085 % одного ядра, на порядок ниже бюджета 1 %.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| 1.6.5-PROCS-Q3 | К DB-половине `/metrics` добавлены пять семейств процесса: задержка цикла событий (p50/p99/max, read-and-reset), RSS/heap, число и объём live-событий по типу; наблюдатели стартуют лениво на первом авторизованном скрейпе | `server/src/myrmidon/monitoring/metrics/process-metrics.ts`, `server/src/myrmidon/monitoring/metrics/metrics.ts`, `server/src/myrmidon/monitoring/metrics/routes.ts`, `server/src/myrmidon/monitoring/metrics/index.ts` | Этап 0 проекта «несколько процессов доски» (design §1): решение о разделении на процессы невозможно без задержки цикла событий и объёма live-потока; метрики должны жить в существующей экспозиции, а не в новом эндпоинте | `server/src/myrmidon/monitoring/metrics/process-metrics.myrmidon.test.ts` (счёт по типу и байтам, ровно один учёт на публикацию, идемпотентный старт, read-and-reset квантили, seam-инъекция), `server/src/myrmidon/monitoring/metrics/exposition.myrmidon.test.ts` (семейства и образцы в экспозиции), `server/src/myrmidon/monitoring/metrics/selfcheck.myrmidon.test.ts` (процесс-семейства выживают битую БД) | Удалить пять семейств из METRIC_FAMILIES/рендеринга и `process-metrics.ts`; публикуемая метрика снимается вместе с подписчиком в routes.ts | — |
