---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### Unknown plugin action/data/tool keys answer 400 UNKNOWN_ACTION with the list of known keys (1.6.5-F17)

- The plugin SDK worker host now reports an unknown action, data, or tool key
  as a structured error: JSON-RPC code `-32007`
  (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) whose `data` carries
  `{ error, known }` — `error` is one of `unknown_action`,
  `unknown_data_key`, `unknown_tool`, and `known` lists the keys the worker
  actually registered. (Unknown job keys are not part of this contract:
  `runJob` for an unregistered job still throws a plain error.)
- The plugin bridge maps that code to a caller error. The four bridge routes
  (`POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key`, `.../actions/:key`) now answer `400` with
  `{ code: "UNKNOWN_ACTION", message, details }` instead of `502`, and the
  board path of `POST /api/plugins/tools/execute` answers `400` with
  `{ error, code: "UNKNOWN_ACTION", details }` (no `message` field)
  instead of `500` (`UNKNOWN_ACTION` joins `PLUGIN_BRIDGE_ERROR_CODES`). An
  unavailable or not-ready worker still answers `502`; only the unknown-key
  class moved.
- Handler errors from worker RPC methods now forward their `err.data` payload
  to the caller (error codes were already propagated before). The follow-up
  release entry «worker `err.data` is forwarded only for `UNKNOWN_ACTION`
  and only when JSON-serializable» covers how much `data` rides along.

## changelog-ru

### Неизвестный ключ действия/данных/инструмента плагина отвечает 400 UNKNOWN_ACTION со списком известных ключей (1.6.5-F17)

- Воркер-хост SDK плагинов теперь сообщает о неизвестном ключе действия,
  данных или инструмента структурированной ошибкой: код JSON-RPC `-32007`
  (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`), в `data` которой лежит
  `{ error, known }` — `error` принимает значения `unknown_action`,
  `unknown_data_key`, `unknown_tool`, а `known` перечисляет ключи, которые
  воркер реально зарегистрировал. (Ключи заданий в этот контракт не входят:
  `runJob` для незарегистрированного задания по-прежнему бросает обычную
  ошибку.)
- Мост плагинов переводит этот код в ошибку вызывающего. Четыре
  bridge-маршрута (`POST /api/plugins/:pluginId/bridge/data`,
  `.../bridge/action`, `.../data/:key`, `.../actions/:key`) теперь отвечают
  `400` с `{ code: "UNKNOWN_ACTION", message, details }` вместо `502`, а
  board-путь `POST /api/plugins/tools/execute` отвечает `400` с
  `{ error, code: "UNKNOWN_ACTION", details }` (без поля `message`) вместо
  `500` (`UNKNOWN_ACTION` добавлен в `PLUGIN_BRIDGE_ERROR_CODES`).
  Недоступный или неготовый воркер по-прежнему отвечает `502`; переехал
  только класс «неизвестный ключ».
- Ошибки обработчиков RPC-методов воркера теперь пересылают вызывающему
  полезную нагрузку `err.data` (коды ошибок передавались и раньше). Сколько
  `data` доезжает при этом, описывает соседняя запись выпуска — «`err.data`
  воркера пересылается только для `UNKNOWN_ACTION` и только если
  сериализуется в JSON».

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-F17 | Неизвестный ключ действия/данных/инструмента плагина — структурированная ошибка вместо голого отказа: SDK кодирует её `-32007` (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) с `data: { error, known }` (`error` — `unknown_action` / `unknown_data_key` / `unknown_tool`, `known` — зарегистрированные ключи; ключи заданий сюда не входят, `runJob` без обработчика бросает обычный Error). Ошибки обработчиков RPC-методов воркера начали пересылать `err.data` вызывающему (коды ошибок сохранялись и до #1048; сколько `data` доезжает — решает санитайзер из ряда F17-2). Серверный мост переводит код в 400 на маршрутах `bridge/data`, `bridge/action`, `data/:key`, `actions/:key` (форма `{ code, message, details }`) и на board-пути `POST /plugins/tools/execute` (форма `{ error, code, details }`); `UNKNOWN_ACTION` добавлен в `PLUGIN_BRIDGE_ERROR_CODES`. Неготовый воркер по-прежнему отвечает 502 | `packages/plugins/sdk/src/protocol.ts` (код `UNKNOWN_ACTION`), `packages/plugins/sdk/src/worker-rpc-host.ts` (throw ветки неизвестных ключей действий/данных/инструментов, пересылка `err.data`), `server/src/routes/plugins.ts` (`case UNKNOWN_ACTION` в `mapRpcErrorToBridgeError`, 400 вместо 502 на четырёх bridge-маршрутах, 400 на board-пути `tools/execute`), `packages/shared/src/constants.ts` (`UNKNOWN_ACTION` в `PLUGIN_BRIDGE_ERROR_CODES`) | Неизвестный ключ — ошибка вызывающего, а не отказ воркера: до правки мост отвечал 502/500, и список допустимых ключей приходилось читать из кода | `packages/plugins/sdk/tests/worker-rpc-host.test.ts` (код и `data.known` для неизвестных ключей), `server/src/__tests__/plugin-routes-authz.test.ts` (400 на `actions/:key`, 502 при отказе воркера) | Когда вендор сам кодирует неизвестный ключ структурированной ошибкой и мостит её в 400: удалить ветки по `PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION` в `plugins.ts` и `case UNKNOWN_ACTION`, вернуть голые throw в воркер-хосте; тесты остаются на вендорском поведении. Снимается независимо от ряда F17-2 (санитайзер `err.data` и 400 на агентском пути) | #1048 |
