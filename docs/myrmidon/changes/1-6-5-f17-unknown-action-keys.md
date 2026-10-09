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
- The plugin bridge maps that code to a caller error: an unknown key on
  `POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key`, `.../actions/:key` and on the board path of
  `POST /api/plugins/tools/execute` now answers `400` with
  `{ code: "UNKNOWN_ACTION", message, details }` instead of `502`/`500`
  (`UNKNOWN_ACTION` joins `PLUGIN_BRIDGE_ERROR_CODES`). An unavailable or
  not-ready worker still answers `502`; only the unknown-key class moved.
- Handler errors from worker RPC methods now keep the code the handler set
  instead of being flattened to a bare `WORKER_ERROR`. The follow-up release
  entry «worker `err.data` is forwarded only for `UNKNOWN_ACTION` and only
  when JSON-serializable» covers how much `data` rides along.

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
- Мост плагинов переводит этот код в ошибку вызывающего: неизвестный ключ на
  `POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key`, `.../actions/:key` и на board-пути
  `POST /api/plugins/tools/execute` теперь отвечает `400` с
  `{ code: "UNKNOWN_ACTION", message, details }` вместо `502`/`500`
  (`UNKNOWN_ACTION` добавлен в `PLUGIN_BRIDGE_ERROR_CODES`). Недоступный или
  неготовый воркер по-прежнему отвечает `502`; переехал только класс
  «неизвестный ключ».
- Ошибки обработчиков RPC-методов воркера теперь сохраняют код, который
  выставил обработчик, вместо сведения к голому `WORKER_ERROR`. Сколько
  `data` доезжает при этом, описывает соседняя запись выпуска — «`err.data`
  воркера пересылается только для `UNKNOWN_ACTION` и только если
  сериализуется в JSON».

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-F17 | Неизвестный ключ действия/данных/инструмента плагина — структурированная ошибка вместо голого отказа: SDK кодирует её `-32007` (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) с `data: { error, known }` (`error` — `unknown_action` / `unknown_data_key` / `unknown_tool`, `known` — зарегистрированные ключи; ключи заданий сюда не входят, `runJob` без обработчика бросает обычный Error). Код ошибки, выставленный обработчиком RPC-метода воркера, сохраняется в ответе вместо сведения к `WORKER_ERROR` (сколько `data` доезжает — решает санитайзер из ряда F17-2). Серверный мост переводит код в 400 `{ code: "UNKNOWN_ACTION", message, details }` на маршрутах `bridge/data`, `bridge/action`, `data/:key`, `actions/:key` и на board-пути `POST /plugins/tools/execute` (агентский путь получил тот же 400 рядом F17-2); `UNKNOWN_ACTION` добавлен в `PLUGIN_BRIDGE_ERROR_CODES`. Неготовый воркер по-прежнему отвечает 502 | `packages/plugins/sdk/src/protocol.ts` (код `UNKNOWN_ACTION`), `packages/plugins/sdk/src/worker-rpc-host.ts` (throw ветки неизвестных ключей действий/данных/инструментов, чтение `err.code` обработчика), `server/src/routes/plugins.ts` (`case UNKNOWN_ACTION` в `mapRpcErrorToBridgeError`, 400 вместо 502 на четырёх bridge-маршрутах, 400 на board-пути `tools/execute`), `packages/shared/src/constants.ts` (`UNKNOWN_ACTION` в `PLUGIN_BRIDGE_ERROR_CODES`) | Неизвестный ключ — ошибка вызывающего, а не отказ воркера: до правки мост отвечал 502/500, и список допустимых ключей приходилось читать из кода | `packages/plugins/sdk/tests/worker-rpc-host.test.ts` (код и `data.known` для неизвестных ключей, сохранение кода обработчика), `server/src/__tests__/plugin-routes-authz.test.ts` (400 на bridge-маршрутах и board-пути `tools/execute`) | Когда вендор сам кодирует неизвестный ключ структурированной ошибкой и мостит её в 400: удалить ветки по `PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION` в `plugins.ts` и `case UNKNOWN_ACTION`, вернуть голые throw в воркер-хосте; тесты остаются на вендорском поведении. Снимается независимо от ряда F17-2 (санитайзер `err.data` и 400 на агентском пути) | #1048 |
