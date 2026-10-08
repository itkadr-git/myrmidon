## changelog-en

### Telegram notifications (TG-NOTIFY-SETTINGS, part A: the settings core)

- The company-level settings that say what the board sends to the owner in
  Telegram: the daily digest, error notifications, inbound rules, escalations
  and head-bot proactivity, as ONE runtime-changeable contract
  (`packages/shared/src/myrmidon-telegram-notify.ts` — types and zod
  validators shared by the server and the UI). Storage without migration:
  the `myrmidonTelegramNotifySettings` key of `instance_settings.general`,
  company-keyed. API: `GET /api/myrmidon/telegram-notify` answers the full
  document (every field of every section always present), `PATCH
  /api/myrmidon/telegram-notify` applies a partial update; each changed
  field is recorded in a bounded changelog (200 entries) with the actor, the
  field path and the from/to values. Reads need company access; PATCH is
  board only. Every section defaults to OFF — with the defaults the owner
  keeps receiving only the replies to their own messages and the U2 decision
  cards; the parts that actually send (digest, errors, inbound, escalations,
  proactivity) consume this contract. No environment variables are added.

## changelog-ru

### Telegram-уведомления (TG-NOTIFY-SETTINGS, часть A: ядро настроек)

- Настройки уровня компании о том, что доска шлёт владельцу в Telegram: ежедневная
  сводка, уведомления об ошибках, входящие правила, эскалации и проактивность
  головного бота — одним контрактом, меняемым на лету
  (`packages/shared/src/myrmidon-telegram-notify.ts`: типы и zod-валидаторы
  для сервера и интерфейса). Хранение без миграции: ключ
  `myrmidonTelegramNotifySettings` в `instance_settings.general`, по компаниям.
  API: `GET /api/myrmidon/telegram-notify` отдаёт полный документ,
  `PATCH /api/myrmidon/telegram-notify` применяет частичное обновление; каждое
  изменённое поле пишется в ограниченный журнал (200 записей) с автором, путём
  поля и значениями до/после. Чтение — с доступом к компании, PATCH — только
  совет. Все разделы по умолчанию выключены: владелец по-прежнему получает
  только ответы на свои сообщения и карточки решений U2. Переменные окружения
  не добавляются.

## divergence-new

<!-- after: 1.6 — SWARM-CLAIM: супервизорский вид, ребаланс и пилотный отчёт (часть B) -->

### 1.6 — TG-NOTIFY-SETTINGS: ядро настроек telegramNotify (часть A)

| ID | Что меняем | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| TG-NOTIFY-A | Ядро настроек «что доска шлёт владельцу в Telegram»: единый runtime-changeable контракт пяти секций (digest, errors, inbound, escalations, proactivity) + журнал изменений, API чтения и частичной правки. Хранение без миграции: ключ `myrmidonTelegramNotify` в `instance_settings.general`, компания-ключённая карта документов (паттерн autonomy/cloud-connector: row-lock + `jsonb_set`, ключ сохраняется при вендорских записях `general`). Маршруты `GET/PATCH /api/myrmidon/telegram-notify` (чтение — доступ к компании, PATCH — только board), компания — из `?companyId=` или единственного членства вызывающего. PATCH — частичный апдейт секций (strict zod), каждая изменённая строка пишет запись changelog (actor, путь поля, from/to; лимит 200). Дефолт всех секций — OFF: с дефолтами владелец получает в Telegram только ответы на свои сообщения и карточки решений U2. Отправку не делает никто: части B–E потребляют контракт | Наши файлы: `packages/shared/src/myrmidon-telegram-notify.ts` (+ его тест), `server/src/myrmidon/telegram-notify/{store,service,routes,index}.ts`, `server/src/myrmidon/telegram-notify/telegram-notify.myrmidon.test.ts`; в вендоре помечены маркером `myrmidon(…)`: `packages/shared/src/index.ts` (одна строка экспорта), `server/src/app.ts` (импорт + одна строка `api.use`), `server/src/services/instance-settings.ts` (импорт + одна preserve-строка) | 1.6.1 TG-NOTIFY-SETTINGS: владелец должен сам решать, что доска присылает в Telegram, без перезапуска и без кода; всё выключено по умолчанию — критерий релиза 1.6.1 (только ответы и карточки U2) | `packages/shared/src/myrmidon-telegram-notify.test.ts` (дефолты, толерантный парсинг испорченных значений, strict-PATCH, закрытые enum, сохранение ключа), `server/src/myrmidon/telegram-notify/telegram-notify.myrmidon.test.ts` (merge и changelog: по записи на поле, без шума на no-op, лимит; компания-скопинг стора; GET-контракт со всеми полями; PATCH 200/400, 403 агентом и чужой компанией, 422 без компании) | Никогда, наше поведение (новый модуль, не вендорский путь). Снять: удалить `server/src/myrmidon/telegram-notify/`, `packages/shared/src/myrmidon-telegram-notify.ts`(+тест), строку экспорта shared и три строки маркера в вендорских файлах | (этот PR) |

## settings-en-new

<!-- after: 1.6 — FORAGING (source registry, snapshot comparison, skill candidates) -->

### 1.6 — TG-NOTIFY-SETTINGS: what the board sends the owner in Telegram (part A, the settings core)

The company-level telegramNotify settings of `server/src/myrmidon/telegram-notify/` (the
TG-NOTIFY-SETTINGS epic, part A). This core only stores and serves the contract;
the parts that actually send (digest, errors, inbound, escalations, proactivity)
consume it. No environment variables: the settings are runtime-changeable per
company through the API.

- Storage: the `myrmidonTelegramNotifySettings` key of `instance_settings.general`, keyed by
  companyId (no migration, the vendor settings service keeps the key across its writes).
- API: `GET /api/myrmidon/telegram-notify` (company access) answers the full document —
  every field of every section always present; `PATCH /api/myrmidon/telegram-notify`
  (board only) applies a partial update, and every changed field is recorded in the
  changelog (actor, field path, from/to values, 200 entries kept).
- Defaults: every section OFF. With the defaults the owner receives only the replies to
  their own messages and the U2 decision cards; nothing else is sent to Telegram until
  a section is turned on.
- Sections: `digest` (time "HH:MM", chatId, topicId, sections list), `errors`
  (minSeverity warn|error|fatal, maxPerHour, chatId, topicId), `inbound`
  (requireMention), `escalations` (hours, channel dm|topic|none, chatId, topicId),
  `proactivity` (mode only_on_owner_request|rarely|normal, rarelyMaxPerDay). The
  proactivity per-agent override lives in `agents.metadata` under the same `"mode"`
  key (company level is the default for all agents).
- Contract: `packages/shared/src/myrmidon-telegram-notify.ts` (types and zod
  validators); the contract is fixed — later changes only add fields, names do not
  change.
