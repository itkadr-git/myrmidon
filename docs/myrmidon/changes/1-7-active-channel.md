---
divergence-section: Трек 4 — чаты и навыки
settings-section: Track 4 — chats and skills
---

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

## settings-en-append

<!-- section: Track 4 — chats and skills -->
Reports and plan answers follow the owner between the portal and Telegram. The portal session heartbeat marks `web`; an inbound Telegram DM marks `telegram`. The inactivity threshold is stored in `instance_settings.general.ownerActiveChannel` and can be changed from Instance → General without a restart. `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` is a forced override only.

| `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` | 1.7-ACTIVE-CHANNEL | `120` minutes | Inactivity threshold used to select the owner's active Web or Telegram channel. The normal value is stored in Instance → General and applies without a restart. | Unset the variable to use the stored setting (default: 120 minutes). |

## settings-ru-append

<!-- section: Трек 4 — чаты и навыки -->
Доклады и ответы по планам следуют за владельцем между порталом и Telegram. Сессия портала отмечает `web`, входящее сообщение в личке Telegram — `telegram`. Порог неактивности хранится в `instance_settings.general.ownerActiveChannel` и меняется в «Экземпляр → Общие настройки» без перезапуска. `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` используется только как принудительное переопределение.

| `MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` | 1.7-ACTIVE-CHANNEL | `120` минут | Порог неактивности для выбора активного канала владельца — Web или Telegram. Обычное значение хранится в «Экземпляр → Общие настройки» и применяется без перезапуска. | Снять переменную, чтобы использовать сохранённую настройку (умолчание: 120 минут). |
