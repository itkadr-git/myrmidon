---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Myrmidon route modules register through one registry point in app.ts (1.6.6 PLUGIN-REGISTRY, part 1)

- `server/src/app.ts` no longer imports the ~65 `./myrmidon/*` route factories
  and no longer carries a 66-line `api.use(...)` block: the app makes ONE registry
  import (plus the two wiring modules its non-route code needs directly) and ONE call, `registerMyrmidonPlugin(api, db, deps)`, backed by the
  ordered registry `server/src/myrmidon/app-plugin.ts`.
- Mount order and route precedence are unchanged — the registry replays the old
  block line-for-line in the same sequence, pinned by
  `server/src/myrmidon/app-plugin.myrmidon.test.ts` (order snapshot, mount
  count, single-import criterion, per-mount `myrmidon(...)` marker check).
- The two pre-auth root mounts outside `/api` (Prometheus metrics, the
  browser-bridge public pairing endpoint) and the board-key-scope middleware
  stay as literal lines in `app.ts`; their factories re-export through the
  registry so `app.ts` keeps the single `./myrmidon/*` import. Startup sweeps
  and schedulers in `index.ts` are out of scope (a separate task).

## changelog-ru

### Модули маршрутов Myrmidon регистрируются через единую точку app-plugin (1.6.6 PLUGIN-REGISTRY, часть 1)

- `server/src/app.ts` больше не импортирует ~65 фабрик маршрутов `./myrmidon/*`
  и не содержит блока `api.use(...)` на 66 строк: у приложения один
  реестровый импорт (`./myrmidon/app-plugin.js`, плюс два wiring-импорта для
  нетуевой кодовой части — voice-stt intake и castes) и один вызов
  `registerMyrmidonPlugin(api, db, deps)`.
- Реестр `server/src/myrmidon/app-plugin.ts` хранит те же фабрики в том же
  порядке (61 монтирование) — приоритет маршрутов не изменился. Порядок закрепляет тест-сторож
  `server/src/myrmidon/app-plugin.myrmidon.test.ts` (снимок порядка, число
  монтирований, критерий одного импорта в app.ts, метка `myrmidon(...)` у
  каждого маунта).
- Два корневых маунта вне `/api` до авторизации (Prometheus-метрики, публичный
  endpoint сопряжения browser-bridge) остаются строками в `app.ts`; их фабрики
  реэкспортированы через реестр. Стартовые свипы в `index.ts` — вне реестра
  (отдельная задача).

## divergence

| PLUGIN-REGISTRY | Все наши маршрутные модули доски регистрируются в `/api` одной точкой: `server/src/app.ts` делает один реестровый импорт `./myrmidon/app-plugin.js` (плюс два wiring-импорта: voice-stt intake и castes) и единственный вызов `registerMyrmidonPlugin(api, db, deps)` вместо 65 импортов фабрик и блока `api.use(...)` (базовые строки 904-969 на main tip bd4d47023); сам реестр `server/src/myrmidon/app-plugin.ts` хранит тот же порядок монтирования и метки `myrmidon(...)`. Корневые маунты вне `/api` (metrics, browser-bridge public) остаются строками в `app.ts` — их фабрики реэкспортированы через реестр | `server/src/app.ts` (секция импортов и блок монтирования маршрутов) | 1.6.6 план п.5 (идея вендора v2026.1001.0 «один плагин — одна регистрация», адаптирована: у нас точечные правки app.ts метками, а не вендорский plugin-manifest) | `server/src/myrmidon/app-plugin.myrmidon.test.ts` (порядок == снимок старого блока 904-969, число монтирований, не больше трёх импортов `./myrmidon/*` в app.ts (реестр + два wiring-модуля), отсутствие безымянных меток) | При переносе вендорского app.ts: точка вставки блока — один вызов `registerMyrmidonPlugin`, новые модули добавляются строкой в `MYRMIDON_API_MOUNTS` (порядок = приоритет маршрутов, менять только осознанно); сам вендорский код реестра не содержит — удалять правкой реестра, не app.ts | (этот PR) |
