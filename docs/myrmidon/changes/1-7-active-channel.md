---
divergence-section: Трек 4 — чаты и навыки
settings-section: Track 4 — chats and skills
---

Release-cut notes (the collector folds only the table-row sections below;
apply these by hand when cutting the release that carries this PR):

1. SETTINGS.ru.md: the RU file uses RU headings, so the collector's single
   settings-section key cannot reach it; append this prose and row to the
   "## Трек 4 — чаты и навыки" section:

Доклады Полководца и ответы по планам уходят в канал, где владелец появился
последним: портал или Telegram. Отметки активности пишет доска: запрос с
сессией владельца помечает `web`, входящее сообщение в мостовой Telegram-личке
(X8b) — `telegram`. Канал считается активным, пока его отметка свежее порога
неактивности; порог хранится в `instance_settings.general.ownerActiveChannel`
и меняется на лету (Instance → General, «Активный канал владельца»,
`PATCH /api/myrmidon/owner/active-channel`) — без перезапуска, следующее
решение о доставке уже использует новое значение.
`MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` — только принудительное переопределение.
Гайд: [guides/owner-active-channel.ru.md](guides/owner-active-channel.ru.md).

   RU table row for that section:

   | Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
   | `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` | 1.7-ACTIVE-CHANNEL | `120` (2 часа) | Порог неактивности каналов владельца, минуты (5–10080): канал активен, пока его последняя отметка свежее порога; доклад уходит туда, где владелец активен (Telegram-личка при активности там, карточка остаётся на доске при активности в портале, прежнее правило U2 при молчании обоих каналов). Хранится в `instance_settings.general.ownerActiveChannel`, меняется на лету из Instance → General без перезапуска | Не задана, пустая или не целое — умолчание; вне 5–10080 прижимается к границам. Снять переопределение: удалить переменную |

## changelog-en

### Owner active channel: reports follow the owner between portal and Telegram (1.7-ACTIVE-CHANNEL)

- The board now marks the owner's last activity per channel — a portal
  session request touches `web`, an inbound Telegram DM message touches
  `telegram` — and answers `GET /api/myrmidon/owner/active-channel` with the
  channel the owner is active in, the last touches and the inactivity
  threshold with the source of its value.
- Report cards (questions and confirmations from ordinary tasks) go to the
  channel the owner is using: Telegram while they are active there, board-only
  while they are active on the board, and the standing U2 Telegram binding
  when neither channel is recent. The threshold is an instance setting,
  changed from Instance → General without a restart.
- The shell's "Web · now" / "Owner · Web" literals are gone: the rail footer
  and the phone header show the real active channel, refreshed without a
  reload.
- New table `myrmidon_owner_activity` (one row per user and channel), the
  shared contract `myrmidon-owner-active-channel.ts`, and guides
  `docs/myrmidon/guides/owner-active-channel.md` / `.ru.md`.

## changelog-ru

### Активный канал владельца: доклады следуют за владельцем между порталом и Telegram (1.7-ACTIVE-CHANNEL)

- Доска отмечает последнюю активность владельца по каналам: запрос сессии
  помечает `web`, входящее сообщение в Telegram-личку — `telegram`;
  `GET /api/myrmidon/owner/active-channel` отвечает активным каналом,
  отметками и порогом неактивности с показом источника значения.
- Карточки докладов (вопросы и согласования с обычных задач) уходят туда, где
  владелец сейчас: в Telegram, пока активен там; остаются на доске, пока
  активен в портале; при молчании обоих каналов — прежнее правило U2 (личка).
  Порог — настройка инстанса, меняется из Instance → General без перезапуска.
- Литералы «Web · now» / «Owner · Web» убраны: футер рельса и шапка телефона
  показывают реальный активный канал без перезагрузки страницы.
- Новая таблица `myrmidon_owner_activity` (строка на пользователя и канал),
  контракт shared `myrmidon-owner-active-channel.ts`, гайды
  `docs/myrmidon/guides/owner-active-channel.md` / `.ru.md`.

## divergence

| 1.7-ACTIVE-CHANNEL | Отметка активности владельца по каналам и доставка докладов в активный канал: запрос сессии пользователя помечает `web` (аддитивный вызов после сборки board-актора), входящее сообщение в мостовой Telegram-личке помечает `telegram`, карточка вопроса/согласования с обычной задачи уходит в Telegram только когда владелец активен там либо ни один канал не активен (прежнее правило U2), а при активности в портале остаётся на доске. Путь U2 переезжает из `owner-delivery/telegram-owner-bindings.ts` в `owner-active-channel/owner-delivery-gate.ts` без изменения правил поиска разговора | `server/src/middleware/auth.ts` (один вызов touch с меткой `myrmidon(1.7-ACTIVE-CHANNEL)` в session-ветке), `server/src/services/chat-channels.ts` (один вызов touch после `taskMutation` в x8Dm-блоке + импорт), `server/src/services/chat-interaction-publications.ts` (замена импорта U2-модуля, точка вызова та же), `server/src/services/instance-settings.ts` (preserve-строка нашего ключа + импорт), `packages/shared/src/validators/instance.ts` (ключ `ownerActiveChannel` в general-схеме + импорт), `packages/shared/src/index.ts` (одна строка экспорта контракта), `packages/db/src/schema/index.ts` (экспорт таблицы), `server/src/app.ts` (импорт + монтаж маршрута), удалён `server/src/myrmidon/owner-delivery/telegram-owner-bindings.ts` (перенесён); + `packages/shared/src/myrmidon-owner-active-channel.ts`, `packages/db/src/schema/myrmidon_owner_activity.ts`, `packages/db/src/migrations/0305_owner_active_channel.sql` + `meta/0305_snapshot.json` + правка `meta/_journal.json`, `server/src/myrmidon/owner-active-channel/{store,settings,service,routes,index,owner-delivery-gate}.ts`, `ui/src/ui2/useOwnerActiveChannel.ts`, `ui/src/components/myrmidon/OwnerActiveChannelSettingsPanel.tsx`, `ui/src/components/myrmidon/ownerActiveChannelApi.ts`, `ui/src/pages/InstanceGeneralSettings.tsx` (монтаж панели), `ui/src/ui2/shell/Ui2Rail.tsx` и `Ui2PhoneNav.tsx` (литерал → реальный канал), `ui/src/ui2/i18n/catalogs/en.ts`/`ru.ts` (ключи статуса), `ui/src/i18n/locales/*.json` (40 файлов — по одному блоку `ui2.shell.activeChannel` ради паритета locales), `ui/src/i18n/myrmidon-locales/en.json`/`ru.json` (панель настроек), `docs/myrmidon/README.md` (строка гайда), тесты `*.myrmidon.test.ts(x)` | Постановка 1.7 ACTIVE-CHANNEL: доклады Полководца и ответы по планам приходят в канал, где владелец активен сейчас; в интерфейсе был литерал «Web · сейчас», API статуса не было | `packages/shared/src/myrmidon-owner-active-channel.myrmidon.test.ts`, `server/src/myrmidon/owner-active-channel/routes.myrmidon.test.ts`, `server/src/__tests__/owner-active-channel.myrmidon.test.ts` (embedded PG: сообщение владельца в Telegram делает Telegram активным и карточка уходит туда; активность в портале оставляет карточку на доске; PATCH порога меняет следующее решение без перезапуска), `server/src/__tests__/owner-telegram-delivery.myrmidon.test.ts` (прежний U2-путь без отметок активности работает как раньше) | Никогда, наше поведение. При переносе сохранять куски с меткой `myrmidon(1.7-ACTIVE-CHANNEL)` в вендорских файлах; если вендор сам отметит активность владельца — удалить модуль `owner-active-channel/`, таблицу с миграцией, метки и тесты, путь U2 вернуть в `owner-delivery/` | (этот PR) |

## settings-en

| `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` | 1.7-ACTIVE-CHANNEL | `120` (2 hours) | Inactivity threshold of the owner's channels, minutes (5–10080): a channel is active while its last owner touch is fresher than the threshold. Reports (questions and confirmations on ordinary tasks) go where the owner is active — Telegram DM while they are active there, board-only while they are active on the board, and the standing U2 Telegram rule when both channels are silent. Stored in `instance_settings.general.ownerActiveChannel` and changed live from Instance → General ("Owner active channel"), `PATCH /api/myrmidon/owner/active-channel` — the next delivery decision uses it, no restart. The environment variable is a forced override only | Unset, empty or non-integer — the default; values outside 5–10080 clamp to the bounds. To release the override, unset the variable; to drop a stored value, delete the key from `general.ownerActiveChannel` — then the environment or the default applies |
