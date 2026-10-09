---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### Plugin worker errors no longer leak `err.data`; unknown tool key is 400 for agents too (F17 part 2)

- `packages/plugins/sdk/src/worker-rpc-host.ts`: a plugin handler's `err.data`
  is forwarded only for `UNKNOWN_ACTION` (RPC code `-32007`), and only when the
  payload round-trips through JSON. A cyclic reference or a `BigInt` in `data`
  previously threw inside the bare `JSON.stringify` of `serializeMessage`, the
  outer `.catch` retried with the same payload and swallowed — the host waited
  for the RPC timeout. Now the response goes out without `data`. For every
  other error code `data` is dropped entirely: an ofetch `FetchError` carries
  the external service's response body in `.data`, and the bridges forwarded it
  to the browser/agent as `details`.
- `server/src/routes/plugins.ts`: `POST /plugins/tools/execute` on the agent
  (toolGateway) path now maps `UNKNOWN_ACTION` (-32007) to **400** with
  `{ code: "UNKNOWN_ACTION", details }` — the same contract the board path
  already had — instead of 500/502.
- `packages/plugins/plugin-llm-wiki`: the «jobs ↔ handlers» guard actually
  fails now when a manifest job has no worker handler or vice versa (the old
  test spied on `runJob` itself and swallowed the rejection), and the
  package's tests run in CI again (`react` is a devDependency so vitest can
  load it inside the workspace; the host still supplies `react` at runtime
  per the `peerDependencies` contract).

## changelog-ru

### Ошибки воркеров плагинов больше не утекают через `err.data`; неизвестный ключ инструмента — 400 и для агентов (F17 часть 2)

- `packages/plugins/sdk/src/worker-rpc-host.ts`: `err.data` из обработчика
  плагина пересылается только для `UNKNOWN_ACTION` (код RPC `-32007`) и только
  если полезная нагрузка сериализуется в JSON. Циклическая ссылка или `BigInt`
  в `data` раньше бросали исключение в голом `JSON.stringify` внутри
  `serializeMessage`, внешний `.catch` повторял с тем же payload и глотал —
  хост ждал до таймаута RPC. Теперь ответ уходит без `data`. Для всех
  остальных кодов `data` отбрасывается целиком: `FetchError` из ofetch кладёт
  в `.data` тело ответа внешнего сервиса, а мосты отдавали его клиенту как
  `details`.
- `server/src/routes/plugins.ts`: `POST /plugins/tools/execute` на агентском
  пути (toolGateway) теперь отображает `UNKNOWN_ACTION` (-32007) в **400** с
  `{ code: "UNKNOWN_ACTION", details }` — тот же контракт, что уже был у
  board-пути, — вместо 500/502.
- `packages/plugins/plugin-llm-wiki`: проверка «jobs ↔ handlers» теперь
  реально падает, когда у задания из манифеста нет обработчика в воркере или
  наоборот (старый тест шпионил сам `runJob` и гасил отказ), а тесты пакета
  снова исполняются в CI (`react` — devDependency, чтобы vitest мог его
  загрузить в воркспейсе; в рантайме `react` по-прежнему поставляет хост по
  контракту `peerDependencies`).

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| F17-2 | Воркер-плагины: `err.data` пересылается только при `UNKNOWN_ACTION` (-32007) и только JSON-сериализуемое; `POST /plugins/tools/execute` на агентском пути toolGateway отображает `UNKNOWN_ACTION` в 400 (контракт board-пути), остальные ошибки воркера — 500/502 как раньше | `packages/plugins/sdk/src/worker-rpc-host.ts` (санитайзер `sanitizeErrorData`/`errorDataForResponse` на обеих ветках ошибок RPC), `server/src/routes/plugins.ts` (ветка 400 в catch агентского пути `/plugins/tools/execute`, 501 только когда нет ни dispatcher, ни toolGateway) | Утечка тела ответа внешнего сервиса через `FetchError.data` в браузер/агенту; зависание вызова до таймаута при циклическом/BigInt `data` (исключение в `JSON.stringify` глоталось внешним `.catch`); агенты получали 500/502 там, где board — 400 | `packages/plugins/sdk/tests/worker-rpc-host.test.ts` (циклический/BigInt data → ответ без data; WORKER_ERROR → data отброшен; JSON-safe UNKNOWN_ACTION data доезжает), `server/src/__tests__/plugin-routes-authz.test.ts` (агентский путь: неизвестный ключ → 400 UNKNOWN_ACTION, воркер-ошибка → 500) | Когда вендор сам введёт типизированные коды ошибок воркера и маппинг 400 на агентском пути — удалить санитайзер и ветку, тесты оставить | (этот PR) |
