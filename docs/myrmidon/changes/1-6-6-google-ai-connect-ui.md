---
settings-section: 1.6.6 — GOOGLE-AI-CONNECT-UI: Google AI Pro subscription connector
---

## changelog-en

### Google AI Pro: the owner connects the subscription from the board (1.6.6 GOOGLE-AI-CONNECT-UI, part C1)

- New section Settings → Google AI Pro. The owner connects the company to a
  Google AI Pro subscription through the private bridge: the screen shows the
  Google terms and risks of the path (consumer subscription automation is a
  reverse-engineered web app, an AGPL project, a ToS risk; the official Gemini
  CLI token route is explicitly forbidden by ToS) *before* the Connect button,
  then a one-time sign-in with no operator and no console — the owner exports
  the cookies of their own `gemini.google.com` session from their browser and
  pastes the JSON. The bundle lands in the company's secrets in the board's
  secret store (write-only: no route ever returns the value, only the secret id
  and cookie names); the operator capture/rotate scripts stay as the fallback
  path. Buttons Reconnect (a new paste, same secret, new version) and
  Disconnect (removes the secret) and a status line: connected / expired /
  error plus the date of the last check.
- Grants per agent on the same screen (the tool_connections vendor model):
  who may `generate_image`, `generate_video`, `creative_text` — a concrete
  agent, a caste, or everyone. Video is shown as disabled while the bridge
  runs in offline video mode; the grant stays but calls refuse. A trial-image
  button runs one generation as the owner and shows the result paths.
- Accounting: every call and every refusal (grant denied, session stale, quota
  refused) is appended to the connector journal in `instance_settings.general`,
  newest first, bounded; the screen shows per-agent counts and the recent
  entries. The bridge keeps its own `gai-audit.jsonl` beside it.
- Expiry: the scheduled sweep and the owner's "check now" probe the bridge's
  `GET /v1/health`; when the session flips to stale, the screen shows
  "expired" and the owner gets a plain question in the Telegram channel from
  the notifier, with the reconnection instruction. The bridge contract is the
  frozen one (bridge 8080, MCP 127.0.0.1:18081→8081, `/v1/generate`,
  `/v1/jobs/{id}`, `/v1/health`, errors session_stale / video_disabled /
  job_not_found / quota_* / transport_error).

## changelog-ru

### Google AI Pro: владелец подключает подписку с доски (1.6.6 GOOGLE-AI-CONNECT-UI, часть C1)

- Новый раздел Настройки → Google AI Pro. Владелец подключает компанию к
  подписке Google AI Pro через приватный мост: экран сначала показывает
  условия и риски Google этого пути (автоматизация потребительской подписки =
  реверс веб-приложения, проект AGPL, риск по ToS; официальный путь токена
  Gemini CLI ToS запрещает прямо) — до кнопки «Подключить», дальше одноразовый
  вход без оператора и консоли: владелец выгружает cookie своей сессии
  `gemini.google.com` из браузера и вставляет JSON. Набор ложится в секреты
  компании в хранилище секретов доски (write-only: значения наружу не отдаёт ни
  один маршрут, видны только id секрета и имена cookie); скрипты захвата и
  ротации оператора остаются аварийным путём. Кнопки «Переподключить» (новая
  вставка, тот же секрет, новая версия) и «Отключить» (секрет удаляется),
  статусная строка: подключено / истекло / ошибка и дата последней проверки.
- Гранты по агентам на том же экране (модель грантов tool_connections): кто
  может `generate_image`, `generate_video`, `creative_text` — конкретный агент,
  каста или все. Видео показывается как выключенное, пока мост работает в
  офлайн-режиме видео: грант остаётся, вызовы отклоняются. Кнопка пробной
  картинки запускает одну генерацию от имени владельца и показывает пути
  результата.
- Учёт: каждый вызов и каждый отказ (нет гранта, сессия истекла, квота
  отказала) добавляется в журнал коннектора в `instance_settings.general`,
  свежие первыми, с ограничением размера; экран показывает счётчики по агентам
  и последние записи. Мост ведёт свой `gai-audit.jsonl` рядом.
- Истечение: периодический sweep и кнопка «проверить сейчас» опрашивают
  `GET /v1/health` моста; когда сессия переходит в stale, экран показывает
  «истекло», а владельцу в Telegram-канал приходит простой вопрос от
  уведомителя с инструкцией переподключения. Контракт моста замороженный
  (мост 8080, MCP 127.0.0.1:18081→8081, `/v1/generate`, `/v1/jobs/{id}`,
  `/v1/health`, ошибки session_stale / video_disabled / job_not_found /
  quota_* / transport_error).

## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.6 — GOOGLE-AI-CONNECT-UI: подключение подписки Google AI Pro владельцем из интерфейса

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| GOOGLE-AI-CONNECT-UI | Модуль коннектора подписки Google AI Pro: состояние и гранты в `instance_settings.general.myrmidonGoogleAiConnector` (без миграций), cookie-набор владельца — в секрете компании (`myrmidon-google-ai-session`, write-only, значение наружу не отдаётся); маршруты `/api/myrmidon/google-ai-connector/*` (настройка — только владелец компании; `POST /call` и `GET /jobs/:id` — агенту по гранту; `GET /session` — мосту по аварийному bearer-токену); периодический sweep здоровья моста с переходом в «истекло» и вопросом владельцу в Telegram-канал; экран «Настройки → Google AI Pro» (условия и риски до кнопки «Подключить», вставка JSON cookie, статус, гранты, пробная картинка, журнал). Контракт моста заморожен | Наши файлы: `server/src/myrmidon/google-ai-connector/**` (cookies, bridge, store, service, session-store, types, identity, routes, sweep, notify, index, sweep-wiring), `packages/shared/src/myrmidon-google-ai-connector.ts` (контракты и zod-схемы), `ui/src/components/myrmidon/google-ai/**` (gaiApi, GoogleAiSettingsPage); метки `myrmidon(GOOGLE-AI-CONNECT-UI)` в вендоре: `server/src/app.ts` (импорт и `api.use`), `server/src/index.ts` (запуск sweep), `server/src/services/instance-settings.ts` (`preserveGoogleAiConnectorGeneralKey`), `ui/src/App.tsx` (маршрут), `ui/src/components/access/CompanySettingsNav.tsx` (пункт раздела), локали `ui/src/i18n/myrmidon-locales/{en,ru}.json` (`googleAi`, `settingsNav.googleAi`) | Владелец подписки Google AI Pro должен подключать её к доске сам, из интерфейса, без оператора и консоли; секреты при этом живут только в хранилище секретов доски (write-only), а истечение сессии превращается в понятный вопрос владельцу, а не в тихую ошибку агента | `server/src/myrmidon/google-ai-connector/cookies.myrmidon.test.ts` (форматы вставки, фильтрация имён, отбор доменов, отказ мусор-ввод), `store.myrmidon.test.ts` (granты: upsert по (capability, agentId/caste), удаление, журнал bounded), `service.myrmidon.test.ts` (connect → секрет, reconnect — та же запись, rotate, disconnect → remove; грант-решение; trial от имени владельца), `routes.myrmidon.test.ts` (401/403, владелец vs member, агент на конфигурации 403, call/capability, 404 на jobs чужой компании) | Никогда, наше поведение. Снятие: удалить каталог модуля, shared-файл, каталог экрана, строки с меткой `myrmidon(GOOGLE-AI-CONNECT-UI)` и этот фрагмент; секрет-запись чистится disconnect'ом или вручную | (этот PR) |

## settings-en-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: matrix enforcement tests and route mapping -->

### 1.6.6 — GOOGLE-AI-CONNECT-UI: Google AI Pro subscription connector

`MYRMIDON_GOOGLE_AI_BRIDGE_URL` | GOOGLE-AI-CONNECT-UI | unset (connector screen shows «bridge unavailable») | base URL of the private bridge container (`google-ai-bridge`, internal 8080); unset or `off` disables all bridge calls | unset it again

`MYRMIDON_GOOGLE_AI_DELIVERY` | GOOGLE-AI-CONNECT-UI | `endpoint` | how the session secret reaches the bridge: `endpoint` — the bridge pulls the current bundle from `GET /api/myrmidon/google-ai-connector/session`; `off` — the operator runbook path only, the pull endpoint answers 404 | set `off`

`MYRMIDON_GOOGLE_AI_DELIVERY_TOKEN` | GOOGLE-AI-CONNECT-UI | unset (pull endpoint answers 404) | bearer token the bridge presents at the session-delivery route; compared in full, never logged | unset it

`MYRMIDON_GOOGLE_AI_SWEEP_SEC` | GOOGLE-AI-CONNECT-UI | 900 (clamped 60…86400) | period of the bridge health sweep: probes `GET /v1/health` of the bridge for every connected company and turns `session=stale` into the screen status plus one Telegram question to the owner channel | set a value outside the range to get the default; removing the module removes the sweep

The connector's state (connections, grants, journal) lives under
`instance_settings.general.myrmidonGoogleAiConnector` and survives vendor
writes of `general` through `preserveGoogleAiConnectorGeneralKey`; the cookie
bundle lives only in a company secret (`myrmidon-google-ai-session`,
write-only — no board route returns its value). No migrations.

## settings-ru-new

<!-- after: 1.6.5 — DOCKERGATE-A2A3-STORM: согласование темпа запросов доски к dockergate -->

### 1.6.6 — GOOGLE-AI-CONNECT-UI: коннектор подписки Google AI Pro

`MYRMIDON_GOOGLE_AI_BRIDGE_URL` | GOOGLE-AI-CONNECT-UI | не задан (экран показывает «мост недоступен») | базовый адрес приватного контейнера моста (`google-ai-bridge`, внутренний 8080); не задан или `off` — вызовы моста отключены | снять переменную

`MYRMIDON_GOOGLE_AI_DELIVERY` | GOOGLE-AI-CONNECT-UI | `endpoint` | как секрет сессии попадает к мосту: `endpoint` — мост забирает текущий набор через `GET /api/myrmidon/google-ai-connector/session`; `off` — только аварийный путь оператора, маршруты отдачи отвечают 404 | поставить `off`

`MYRMIDON_GOOGLE_AI_DELIVERY_TOKEN` | GOOGLE-AI-CONNECT-UI | не задан (маршрут отдачи отвечает 404) | bearer-токен, который мост предъявляет на маршруте отдачи сессии; сравнивается целиком, не логируется | снять переменную

`MYRMIDON_GOOGLE_AI_SWEEP_SEC` | GOOGLE-AI-CONNECT-UI | 900 (ограничение 60…86400) | период опроса здоровья моста: для каждой подключённой компании проверяется `GET /v1/health`, переход `session=stale` даёт статус «истекло» и один вопрос владельцу в Telegram-канал | поставить значение вне диапазона — вернётся умолчание; удаление модуля убирает sweep

Состояние коннектора (подключения, гранты, журнал) лежит под ключом
`instance_settings.general.myrmidonGoogleAiConnector` и переживает записи
вендора в `general` благодаря `preserveGoogleAiConnectorGeneralKey`; набор
cookie живёт только в секрете компании (`myrmidon-google-ai-session`,
write-only — ни один маршрут доски не отдаёт значение). Миграций нет.
