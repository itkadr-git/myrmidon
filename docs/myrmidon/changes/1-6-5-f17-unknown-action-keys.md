---
divergence-section: 1.2 — плагины
---

## changelog-en

### Unknown plugin action/data/tool keys now answer 400 UNKNOWN_ACTION with the list of known keys (1.6.5-F17)

- The plugin SDK worker host now reports an unknown action, data, tool, or job
  key as a structured error: JSON-RPC code `-32007`
  (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) whose `data` carries
  `{ error, known }` — `error` is one of `unknown_action`,
  `unknown_data_key`, `unknown_tool`, and `known` lists the keys the worker
  actually registered. Any error code a handler throws (including
  `UNKNOWN_ACTION`) is propagated with its `data` instead of being flattened
  to a bare `WORKER_ERROR`.
- The plugin bridge maps that code to a caller error: an unknown key on
  `POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key` or `.../actions/:key` now answers `400` with
  `{ code: "UNKNOWN_ACTION", message, details: { error, known } }` instead of
  `502`, and a tool that exists in the dispatcher registry but has no worker
  handler answers `400` with `code: "UNKNOWN_ACTION"` instead of `502`/`500`.
  A worker that is down still answers `502`; only the unknown-key class moved.
- The LLM Wiki plugin gained a guard test that pins both directions of the
  jobs↔handlers contract: every job declared in the manifest must have a
  registered worker handler, and every handler the worker registers must be
  declared in the manifest — so a manifest job without a handler can no longer
  reach the board as a `502`.

## changelog-ru

### Неизвестный ключ действия/данных/инструмента плагина теперь отвечает 400 UNKNOWN_ACTION со списком известных ключей (1.6.5-F17)

- Воркер-хост SDK плагинов теперь сообщает о неизвестном ключе действия,
  данных, инструмента или задания структурированной ошибкой: код JSON-RPC
  `-32007` (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`), в `data` которой лежит
  `{ error, known }` — `error` принимает значения `unknown_action`,
  `unknown_data_key`, `unknown_tool`, а `known` перечисляет ключи, которые
  воркер реально зарегистрировал. Любой код ошибки, который бросает
  обработчик (включая `UNKNOWN_ACTION`), теперь прокидывается вместе с `data`,
  а не сводится к голому `WORKER_ERROR`.
- Мост плагинов переводит этот код в ошибку вызывающего: неизвестный ключ на
  `POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key` или `.../actions/:key` теперь отвечает `400` с
  `{ code: "UNKNOWN_ACTION", message, details: { error, known } }` вместо
  `502`, а инструмент, который есть в реестре диспетчера, но не имеет
  обработчика в воркере, отвечает `400` с `code: "UNKNOWN_ACTION"` вместо
  `502`/`500`. Неработающий воркер по-прежнему отвечает `502`; переехал
  только класс «неизвестный ключ».
- В плагине LLM Wiki появился сторожевой тест, который фиксирует договор
  jobs↔handlers в обе стороны: каждое задание, объявленное в манифесте,
  должно иметь зарегистрированный обработчик в воркере, а каждый
  зарегистрированный обработчик — быть объявленным в манифесте, так что
  задание из манифеста без обработчика больше не доходит до доски как `502`.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-F17 | Неизвестный ключ действия/данных/инструмента/задания плагина — структурированная ошибка вместо голого отказа: SDK кодирует её `-32007` (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) с `data: { error, known }` (`error` — `unknown_action` / `unknown_data_key` / `unknown_tool`, `known` — зарегистрированные ключи); произвольный код ошибки обработчика прокидывается с `data`, а не сводится к `WORKER_ERROR`. Серверный мост переводит код в 400 `{ code: "UNKNOWN_ACTION", message, details }` на маршрутах `bridge/data`, `bridge/action`, `data/:key`, `actions/:key` и на вызове инструмента, у которого нет обработчика в воркере (раньше — 502); упавший воркер по-прежнему отвечает 502 | `packages/plugins/sdk/src/protocol.ts` (код `UNKNOWN_ACTION`), `packages/plugins/sdk/src/worker-rpc-host.ts` (throw ветки unknown-ключей, прокид `err.data` в `createErrorResponse`), `server/src/routes/plugins.ts` (ветка 400 по коду, `case UNKNOWN_ACTION` в маппере моста, 400 вместо 502 на четырёх bridge-маршрутах), `packages/shared/src/constants.ts` (`UNKNOWN_ACTION` в `PLUGIN_BRIDGE_ERROR_CODES`) | Неизвестный ключ — ошибка вызывающего, а не отказ воркера: до правки мост отвечал 502, и список допустимых ключей приходилось читать из кода; LLM Wiki объявляла задание `folder-health-check` без обработчика, и его запуск падал 502 вместо понятного 400 | `packages/plugins/sdk/tests/worker-rpc-host.test.ts` (код, `data.known`, прокид кода+`data` обработчика), `server/src/__tests__/plugin-routes-authz.test.ts` (400 на четырёх маршрутах и на вызове инструмента), `packages/plugins/plugin-llm-wiki/tests/plugin.spec.ts` (гард jobs↔handlers в обе стороны, пин действий воркера) | Когда вендор сам кодирует неизвестный ключ структурированной ошибкой и мостит её в 400: удалить ветки по `PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION` в `plugins.ts` и `case UNKNOWN_ACTION`, вернуть голые throw в воркер-хосте; тесты остаются на вендорском поведении | #1048 |
