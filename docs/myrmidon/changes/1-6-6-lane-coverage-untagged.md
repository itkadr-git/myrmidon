---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Board load lanes now cover the auth middleware and the periodic sweeps

- About 71% of the board's DB statements were counted in the `untagged` lane: the request lane was attached only inside the `/api` router, after the auth / actor / run-identity middleware and outside the provider webhook ingress, and the board's own timers inherit the empty context of the startup code that armed them. A request is now tagged `http_route` before any other middleware, and a new `background_sweep` lane covers the periodic sweeps and housekeeping timers (features, alerts, deploy jobs, maintenance, canary, distill, litellm sync, leases, plugin jobs, email polling and others). The `myrmidon_board_db_queries_total{lane}` and `myrmidon_board_lane_busy_seconds_total{lane}` series gain the `background_sweep` label value. Nothing is scheduled, delayed or reordered; only the attribution changes.

## changelog-ru

### Линии нагрузки доски теперь охватывают middleware авторизации и периодические свипы

- Около 71% запросов доски к БД попадали в линию `untagged`: линия запроса вешалась только внутри роутера `/api`, после middleware авторизации, актора и идентичности прогона и мимо приёма вебхуков провайдеров, а собственные таймеры доски наследуют пустой контекст стартового кода, который их взвёл. Теперь запрос получает `http_route` раньше любого другого middleware, а новая линия `background_sweep` охватывает периодические свипы и служебные таймеры (features, alerts, deploy jobs, maintenance, canary, distill, синхронизация litellm, аренды, задания плагинов, опрос почты и другие). В рядах `myrmidon_board_db_queries_total{lane}` и `myrmidon_board_lane_busy_seconds_total{lane}` появляется значение метки `background_sweep`. Ничто не планируется, не откладывается и не переставляется: меняется только атрибуция.

## divergence

| 1.6.6-LANE-COVERAGE | Ранний тег линии `http_route` до middleware авторизации и новая линия `background_sweep` для периодических таймеров | `server/src/app.ts`, `server/src/myrmidon/monitoring/board-load/` (`lanes.ts`, `request-load.ts`), замены `setInterval` на `backgroundInterval` с меткой `myrmidon(1.6.6 OPE-9058)` | Линия, поставленная внутри роутера `/api`, не видит запросов к БД из middleware актора и вебхуков, а таймеры, взведённые при старте, не наследуют линию: около 71% запросов считались `untagged` | `server/src/myrmidon/monitoring/board-load/lanes.myrmidon.test.ts` | Не сворачивать в вендорский код: разметка линий целиком наша | (этот PR) |
