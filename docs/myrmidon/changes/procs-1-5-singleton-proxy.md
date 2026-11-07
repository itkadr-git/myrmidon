---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Single routes are proxied from the api processes to the worker (split mode)

- In the multi-process board (`api` processes + `worker`), an api process forwards the routes
  whose state lives only in the worker to its loopback listener (`127.0.0.1:3101`, or
  `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT` from the launch map): the attention feed
  (`GET /api/companies/:id/attention`), the plugin host (`/api/plugins/**`), the bot-container
  control (`/api/myrmidon/agents/:id/bot-container/**`) and the workspace-runtime control
  (`POST …/runtime-services|runtime-commands/:action` of projects and execution workspaces).
- Authorization is transparent: the request goes through unchanged (credentials, cookies, origin,
  body) and the worker resolves the actor itself; its answer is streamed back as is. A worker that
  does not answer yields `503` with `Retry-After`, never a local answer.
- The existing `Processes` setting `singletonProxy` (default on) switches it, no restart; off means
  the api process serves these routes itself. The single-process board and the worker never proxy.
- New metric `myrmidon_board_singleton_proxy_total{role,route,outcome}` (`proxied` / `unavailable`).

## changelog-ru

### Одиночные маршруты проксируются с api-процессов на worker (режим split)

- В многопроцессной доске (процессы `api` + `worker`) api-процесс пересылает маршруты, состояние
  которых живёт только в worker, на его loopback-слушатель (`127.0.0.1:3101` или
  `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT` из карты запуска): ленту внимания
  (`GET /api/companies/:id/attention`), хост плагинов (`/api/plugins/**`), управление
  bot-container (`/api/myrmidon/agents/:id/bot-container/**`) и управление workspace-runtime
  (`POST …/runtime-services|runtime-commands/:action` проектов и исполнительных рабочих пространств).
- Авторизация прозрачная: запрос уходит без изменений (учётные данные, cookie, origin, тело), актора
  определяет сам worker; ответ возвращается потоком как есть. Если worker не отвечает — `503` с
  `Retry-After`, а не локальный ответ.
- Существующая настройка `singletonProxy` в «Процессах» (по умолчанию включена) переключает проксирование
  без перезапуска; выключена — api-процесс обслуживает эти маршруты сам. Одиночный процесс и worker
  не проксируют никогда.
- Новая метрика `myrmidon_board_singleton_proxy_total{role,route,outcome}` (`proxied` / `unavailable`).
