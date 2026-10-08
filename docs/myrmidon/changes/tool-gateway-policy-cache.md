---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### Tool gateway policy reads are served from a per-company cache with a live TTL (1.6.5 DB-PERF-C-P4)

- Every `tools/list` and every tool call decides access by reading
  `tool_profile_bindings`, `tool_profiles`, `tool_profile_entries` and the
  enabled `tool_policies` of the company. The tables are nearly empty, so the
  cost is the round trips: by the measurement of 06.10 that was ~5.4M statements
  over three days of statistics, with `POST /mcp/gateways` taking 18–26 s on
  average. The four row sets are now served from an in-process cache keyed by
  company (`server/src/myrmidon/tool-policy-cache/`, one cache per server
  process), and the cache stores exactly the rows the gateway read before, so a
  cached read returns the same row sets as a fresh one.
- Setting: `instance_settings.general.toolPolicyCache = { ttlMs }`, changed
  from `GET/PATCH /api/myrmidon/tool-policy-cache` (GET is open to board
  members, PATCH is instance-admin only). Default 30 s, minimum `0` (cache off),
  maximum 300 s. The field is also on the instance settings page ("Tool gateway
  policy cache", in seconds). The cache reads the row on every access, so a change
  applies to the next gateway call without a restart.
- Every write drops the company snapshot, and not only inside the two access
  services: create, update, delete, duplicate and reorder of policies, the
  trust-rule create/revoke and the trust-rule hit (it rewrites
  `tool_policies.config`) in `server/src/services/tool-access-policy.ts`, every
  profile, binding and profile-entry mutation in
  `server/src/services/tool-access.ts`, plus the writers outside both of them —
  the email-channel setup (creates a profile with its entries and bindings), the
  named MCP gateway (binds a profile) and the smoke lab (rewrites and removes its
  own profile rows). A changed policy is therefore visible to the very next
  decision instead of living until the TTL, which closes the risk the database
  audit raised. A load that was already running when the write landed cannot
  put its stale rows into the cache: every invalidation bumps a per-company
  generation counter and a load whose generation moved is dropped and redone
  once. Writes made on a caller's transaction handle (a remembered approval, a
  connection-intent completion, a catalog refresh) invalidate after the commit as
  well, and a service built on a transaction reads straight from the database. A write made
  straight through the database handle (a fixture, a manual fix) is likewise out
  of the cache's reach until the window ends, so the vendor tests that seed these
  four tables directly drop the snapshot themselves — the same way
  `tool-access-service.test.ts` already does for the cloud-connector cache.
- Deliberately not cached: rate-limit counters, audit events and principal
  permission grants. They are per-principal state and the gateway writes to
  them; they stay direct reads and writes.
- `ttlMs: 0` restores the previous behaviour exactly: the cache answers "no
  snapshot", the gateway runs its own statements unchanged, and the statement
  set is the one it had before the cache existed. The only read the cache adds
  in that mode is the settings row that carries the switch itself.
- Guard: `server/src/myrmidon/tool-policy-cache/tool-policy-cache.myrmidon.test.ts`
  drives the cache directly (TTL window, invalidation, eviction cap, the
  switched-off mode) and through the real `toolAccessPolicyService` on a fake
  database handle that counts the SELECTs per table: two decisions inside the
  window cost one snapshot load, a policy change through the API is visible to
  the next read and to the next decision with the clock untouched, and with
  `ttlMs: 0` every decision reads the policy tables again.

## changelog-ru

### Чтения политик шлюза инструментов обслуживает кэш по компании с живым TTL (1.6.5 DB-PERF-C-P4)

- Каждый `tools/list` и каждый вызов инструмента решает доступ, читая
  `tool_profile_bindings`, `tool_profiles`, `tool_profile_entries` и включённые
  `tool_policies` компании. Таблицы почти пусты, поэтому платили за рейсы:
  по замеру 06.10 это ~5,4 млн операторов за три дня статистики, а
  `POST /mcp/gateways` в среднем занимал 18–26 с. Теперь эти четыре набора строк
  обслуживает in-process кэш по компании
  (`server/src/myrmidon/tool-policy-cache/`, один кэш на процесс сервера), и
  кэш хранит ровно те строки, которые шлюз читал раньше, — чтение из кэша даёт
  те же наборы строк, что свежее чтение.
- Настройка: `instance_settings.general.toolPolicyCache = { ttlMs }`, меняется
  через `GET/PATCH /api/myrmidon/tool-policy-cache` (GET — членам доски,
  PATCH — только instance-admin). Умолчание 30 с, минимум `0` (кэш выключен),
  максимум 300 с. Поле есть и на странице настроек инстанса («Tool gateway
  policy cache», в секундах). Кэш читает строку на каждый доступ, поэтому смена
  применяется к следующему вызову шлюза без рестарта.
- Любая запись сбрасывает снимок компании, и не только внутри двух сервисов
  доступа: создание, изменение, удаление, дублирование и перестановка политик,
  создание и отзыв trust rule и попадание в trust rule (оно переписывает
  `tool_policies.config`) в `server/src/services/tool-access-policy.ts`, каждая
  мутация профиля, привязки и записи профиля в
  `server/src/services/tool-access.ts`, а также точки записи вне них — настройка
  почтового канала (создаёт профиль с записями и привязками), именованный
  MCP-шлюз (привязывает профиль) и smoke lab (перезаписывает и удаляет свои
  строки профиля). Поэтому изменение политики видно уже следующему решению, а не
  живёт до TTL, — риск, названный аудитом базы, закрыт. Устаревшие строки в кэш не попадут: загрузка, шедшая в момент записи, не
  кладёт результат в кэш — каждый сброс увеличивает счётчик поколения компании,
  загрузка с изменившимся поколением отбрасывается и повторяется один раз. Записи
  на дескрипторе транзакции вызывающего (запомненное одобрение, завершение
  connection-intent, обновление каталога) сбрасывают снимок ещё и после коммита,
  а сервис, построенный на транзакции, читает прямо из базы. Запись напрямую через дескриптор базы (фикстура, ручная правка) кэшу
  так же не видна до конца окна — поэтому вендорские тесты, которые сеют эти
  четыре таблицы напрямую, сбрасывают снимок сами, как
  `tool-access-service.test.ts` уже делает для кэша cloud-connector.
- Сознательно не кэшируются: счётчики rate limit, события аудита и явные
  разрешения (principal permission grants). Это состояние по конкретному
  участнику, и шлюз в них пишет; они остаются прямыми чтениями и записями.
- `ttlMs: 0` возвращает прежнее поведение полностью: кэш отвечает «снимка нет»,
  шлюз выполняет свои запросы без изменений, и набор операторов — тот же, что
  был до появления кэша. Единственное чтение, которое кэш добавляет в этом
  режиме, — строка настроек, в которой лежит сам выключатель.
- Сторож: `server/src/myrmidon/tool-policy-cache/tool-policy-cache.myrmidon.test.ts`
  проверяет кэш напрямую (окно TTL, сброс, потолок вытеснения, выключенный
  режим) и через настоящий `toolAccessPolicyService` на поддельном дескрипторе
  базы, который считает SELECT'ы по таблицам: два решения внутри окна стоят
  одной загрузки снимка, изменение политики через API видно следующему чтению и
  следующему решению при неподвижных часах, а при `ttlMs: 0` каждое решение
  снова читает таблицы политик.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| DB-PERF-C-P4 | Политики, привязки, профили и записи профилей шлюза инструментов читаются из in-process кэша по компании; TTL — из настройки `instance_settings.general.toolPolicyCache` (`GET/PATCH /api/myrmidon/tool-policy-cache`: умолчание 30 с, `0` — кэш выключен, максимум 300 с; поле есть на странице настроек инстанса). Любая мутация политики, профиля, привязки или записи профиля сбрасывает снимок компании, поэтому изменение политики действует на следующем решении, не дожидаясь TTL. При `ttlMs: 0` кэш отвечает «снимка нет» и шлюз выполняет свои прежние запросы — байт-в-байт тот же набор операторов. Не кэшируются счётчики rate limit, события аудита и явные разрешения | `server/src/services/tool-access-policy.ts` (чтения в `effectiveProfiles` и политик в `decide` плюс восемь точек сброса, метки `myrmidon(DB-PERF-C-P4)`); `server/src/services/tool-access.ts` (точки сброса в CRUD профилей, привязок и записей, тот же маркер); `server/src/services/email-channels.ts`, `server/src/services/tool-gateway.ts`, `server/src/services/smoke-lab.ts` (точки сброса после записи этих таблиц вендором вне сервисов доступа, тот же маркер); `server/src/services/instance-settings.ts` (поле `toolPolicyCache` в `normalizeGeneralSettings` и `updateGeneral`); `server/src/app.ts` (регистрация роутов); `ui/src/components/myrmidon/ToolPolicyCacheSettingsPanel.tsx` (поле TTL на странице настроек инстанса, подключено в `InstanceGeneralSettings.tsx`); + модуль `server/src/myrmidon/tool-policy-cache/` и контракт настройки в `packages/shared/src/myrmidon-tool-policy-cache.ts` | Аудит базы 04.10: каждый вызов шлюза платил ~10 запросов по почти пустым таблицам — ~5,4 млн операторов за три дня статистики, `POST /mcp/gateways` в среднем 18–26 с | `server/src/myrmidon/tool-policy-cache/tool-policy-cache.myrmidon.test.ts` (окно TTL, сброс по компании и полный, потолок вытеснения, режим `ttlMs: 0`, счётчики SELECT'ов по таблицам через настоящий сервис политик, смена TTL через сервис настроек без рестарта, схема и нормализация настройки) | Никогда, наше поведение. Если вендор сам начнёт кэшировать эти чтения в `effectiveProfiles`/`decide` — убрать метки `myrmidon(DB-PERF-C-P4)`, модуль, настройку, роуты и этот фрагмент | (этот PR) |