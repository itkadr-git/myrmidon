## divergence-new

<!-- after: 1.2 — русский интерфейс (UI-RU-A) -->

### 1.7 — AGENT-EXCHANGE A: комната обсуждения на карточке задачи

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| AXA | Комната обсуждения на карточке задачи: 2–4 агента на разных моделях отвечают на тему независимо (первый круг — один параллельный пакет, участник не видит чужих ответов до своего — это обеспечивает сетка `agent_exchange_messages`: одна ячейка на участника на круг), следующие круги видят всю историю и вызываются вручную (`POST …/rounds`), стоп-кран (`POST …/stop`) замораживает комнату без новых вызовов моделей, завершитель пишет итог документом на задачу (`agent-exchange:<roomId>`) со стоимостью в центах по ценам провайдеров. Комната замораживает состав, завершителя и пределы при открытии (строка `agent_exchange_rooms`); пределы — круги (`maxRounds`), бюджет токенов (`tokenBudget`, исчерпание → `stopReason="budget"`), таймаут ответа (ячейка `error`, комната продолжается). Мастер-выключатель `enabled` по умолчанию выключен (открытие → `403 feature_disabled`). Настройки — `instance_settings.general.agentExchange` (ключ в zod-схеме общих настроек; переживает вендорские записи `general` через тот же spread, что `1.7-BUDGET-CONFIG-B`), экран Instance → General и `GET`/`PATCH /api/myrmidon/agent-exchange/settings` без перезапуска (GET — board, PATCH — instance-admin); env `MYRMIDON_AGENT_EXCHANGE_*` — принудительное переопределение для инстанса без сохранённых настроек (прецедентность настройки → env → дефолт, источник каждого значения показывается на экране); ошибка чтения настроек — безопасный отказ (комнаты выключены). Модуль `server/src/myrmidon/agent-exchange/`: `engine.ts` (чистая логика комнаты над интерфейсом стора), `store.ts` (drizzle), `routes.ts`, `wiring.ts` (порт моделей — OpenAI-совместимые вызовы по `baseUrl` провайдера, стоимость из `model_provider_models`), `settings.ts`. Роли и судья DEBATE-ASYM — отдельная часть | `packages/shared/src/index.ts` (экспорт), `packages/shared/src/validators/instance.ts` + `types/instance.ts` (ключ `agentExchange`), `server/src/services/instance-settings.ts` (сохранение ключа), `server/src/app.ts` (импорт + монтирование маршрутов), `packages/db/src/schema/index.ts` (экспорт таблиц), `packages/db/src/migrations/meta/_journal.json` (запись 0307), `ui/src/pages/InstanceGeneralSettings.tsx` (панель) — все помечены `myrmidon(1.7-AGENT-EXCHANGE-A)`; + наши модули `packages/shared/src/myrmidon-agent-exchange.ts`, `packages/db/src/schema/agent_exchange_rooms.ts`, `packages/db/src/migrations/0307_agent_exchange_rooms.sql` + `meta/0307_snapshot.json`, `server/src/myrmidon/agent-exchange/*`, `ui/src/components/myrmidon/{AgentExchangeSettingsPanel.tsx,agentExchangeApi.ts}`, доки `docs/myrmidon/guides/agent-exchange.{md,ru.md}` | OPE-4171 (1.7 AGENT-EXCHANGE A): обмен опытом между агентами вне тикетов — комната на карточке с независимыми первыми ответами, стоп-краном владельца и итогом со стоимостью | `server/src/myrmidon/agent-exchange/engine.myrmidon.test.ts` (комната из 3 участников: независимые первые ответы без чужой истории и итог-документ со стоимостью; стоп-кран — ни одного вызова модели после остановки; предел кругов; бюджет → `budget`; выключено → `feature_disabled`), `server/src/myrmidon/agent-exchange/settings.myrmidon.test.ts` (прецедентность настройки → env → дефолт, источник значения, битый blob → дефолт, ошибка чтения → безопасно выключено) | Когда вендор добавит комнаты обсуждений на задачах — сверить семантику и удалить метки `myrmidon(1.7-AGENT-EXCHANGE-A)`, модуль `agent-exchange/`, панель UI, таблицы и доки | (этот PR) |

## settings-en-new

<!-- after: 1.7 — BUDGET-CONFIG B: enforcement mode of spend limits -->

### 1.7 — AGENT-EXCHANGE-A: discussion rooms on issue cards

A discussion room on an issue card: 2–4 agents on different models answer
independently, rounds are capped, a per-room token budget stops the room, the
owner holds the stop valve, and the finisher's summary lands as an issue
document with the cost. The room rules are a live instance setting — change
them on Instance → General or via `GET`/`PATCH
/api/myrmidon/agent-exchange/settings` (GET is board, PATCH is
instance-admin) with no restart; the next room open applies them. The
environment variables are the forced override for an instance that never
saved the settings (precedence: stored settings → env → default; the
effective source of every key is shown on the screen).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_AGENT_EXCHANGE_ENABLED` | 1.7-AGENT-EXCHANGE-A | unset (`false`) | The master switch of discussion rooms while nothing is stored in `instance_settings.general.agentExchange`: rooms open only when `true` (otherwise `403 feature_disabled`) | Any other value (or unset) — rooms off; once saved from the settings page, the environment stops mattering. Full guide: [guides/agent-exchange.md](guides/agent-exchange.md) |
| `MYRMIDON_AGENT_EXCHANGE_MAX_PARTICIPANTS` | 1.7-AGENT-EXCHANGE-A | unset (`4`) | The largest roster a room may open with (2–4) | Out of range or unreadable — the default |
| `MYRMIDON_AGENT_EXCHANGE_MAX_ROUNDS` | 1.7-AGENT-EXCHANGE-A | unset (`3`) | The rounds allowed after the independent first round (0–8) | Out of range or unreadable — the default |
| `MYRMIDON_AGENT_EXCHANGE_TOKEN_BUDGET` | 1.7-AGENT-EXCHANGE-A | unset (`120000`) | The per-room token budget; spending it stops the room with `stopReason = "budget"` | Out of range or unreadable — the default |
| `MYRMIDON_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS` | 1.7-AGENT-EXCHANGE-A | unset (`90000`) | The per-participant call timeout; a miss marks the grid cell `error` and the room goes on | Out of range or unreadable — the default |
