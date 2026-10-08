## changelog-en

### Settings screens for workspace hygiene, channels and the model-fallback signal (SETTINGS-UI A)

- Three new sections on Instance → General cover the settings routes that
  already existed without a screen: "Workspace hygiene"
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene` — per-workspace and total
  disk ceilings, the last sweep report and the largest workspaces),
  "Channels (Telegram & chat bridges)"
  (`GET`/`PATCH /api/myrmidon/channel-settings` — ten channel fields;
  `telegramApiBaseUrl` stays deployment-only and is shown read-only) and
  "Model fallback signal"
  (`GET`/`PATCH /api/myrmidon/model-fallback/settings` — the switch, the
  threshold, the minimum calls, the window and the check interval).
- The stored row is the source of truth: a saved value applies without a
  restart — the scheduler re-resolves the row before each pass and read paths
  re-check on use. `MYRMIDON_*` environment variables stay forced per-key
  overrides exactly as the server modules already worked; each field in the
  panels shows its origin (`ui`/`settings`, `env` or `default`).
- Numeric fields are range-validated in the panel (the server validator stays
  the authority); an out-of-range or unparseable value blocks the save rather
  than being sent. Every PATCH writes the audit entry the route already
  produces.
- The retention screen (datastore-care) is intentionally not part of this
  slice: the server core is still in progress, the panel lands after it in
  its own follow-up.

## changelog-ru

### Экраны настроек: гигиена рабочих копий, каналы и сигнал фолбэка моделей (SETTINGS-UI A)

- Три новых раздела на Instance → General для маршрутов настроек, у которых
  уже было API, но не было экрана: «Workspace hygiene»
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene` — потолок на копию и на
  сумму, отчёт последнего прохода и самые крупные рабочие копии),
  «Channels (Telegram & chat bridges)»
  (`GET`/`PATCH /api/myrmidon/channel-settings` — десять полей каналов;
  `telegramApiBaseUrl` остаётся развёртываемым и показан только для чтения) и
  «Model fallback signal» (`GET`/`PATCH
  /api/myrmidon/model-fallback/settings` — выключатель, порог, минимум
  вызовов, окно и интервал проверки).
- Источник истины — хранимая строка: сохранённое значение действует без
  рестарта, планировщик перечитывает строку перед каждым проходом. Env-
  переменные `MYRMIDON_*` остаются принудительным переопределением по
  отдельному ключу, как было устроено на сервере; каждое поле показывает
  происхождение значения (`ui`/`settings`, `env` или `default`).
- Числовые поля панель проверяет по диапазону (валидатор сервера остаётся
  старшим); значение вне диапазона или неразбираемое блокирует сохранение.
  Каждый PATCH пишет аудит-запись, которую маршрут уже делал.
- Экран сроков хранения (datastore-care) в эту часть сознательно не входит:
  серверное ядро ещё делается, панель приедет после него отдельным шагом.

## divergence-new

### 1.6.6 — SETTINGS-UI A: экраны workspace-hygiene, channel-settings, model-fallback-signal в настройках инстанса

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| SETTINGS-UI-A | Три панели настроек инстанса поверх существующих GET/PATCH-маршрутов без UI: «Workspace hygiene» (квоты, источники, отчёт последнего прохода, список рабочих копий), «Channels (Telegram & chat bridges)» (десять полей, `telegramApiBaseUrl` read-only), «Model fallback signal» (enabled, thresholdPct, minCalls, windowSec, intervalSec) в разделе Instance → General; каждый ключ показывает источник (`ui`/`settings` / `env` / `default`), env остаётся принудительным переопределением, сохранённое значение применяется без рестарта | Вендор, помечено `myrmidon(SETTINGS-UI A)`: `ui/src/pages/InstanceGeneralSettings.tsx` (три импорта и три монтажа). Наши: `ui/src/components/myrmidon/{workspaceHygieneSettingsApi.ts,WorkspaceHygieneSettingsPanel.tsx,channelSettingsApi.ts,ChannelSettingsPanel.tsx,modelFallbackSignalSettingsApi.ts,ModelFallbackSignalSettingsPanel.tsx}` и три `.myrmidon.test.tsx` | Владелец: маршруты настроек существовали без экрана — значения правились только env или curl; аудит ~100 настроек без UI | `ui/src/components/myrmidon/WorkspaceHygieneSettingsPanel.myrmidon.test.tsx`, `ChannelSettingsPanel.myrmidon.test.tsx`, `ModelFallbackSignalSettingsPanel.myrmidon.test.tsx` (рендер из view-ответа, источники значений, тела PATCH только с изменёнными полями, блокировка сохранения при значении вне диапазона) | Никогда, наше поведение. Снятие: удалить три панели и их API-модули, убрать три монтажа из `InstanceGeneralSettings.tsx` | (этот PR) |
