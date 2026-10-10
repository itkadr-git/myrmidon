---
settings-section: Track 4 — chats and skills
---

## changelog-en

### CONNECTORS C: the chat-provider-telegram connector (installation flag only, no traffic switch) (1.6.6)

- New `server/src/myrmidon/channel-connectors/telegram.ts`: the Telegram
  connector over the S1 contract — lifecycle (`start`/`stop`/`status` read the
  vendor row without rewriting it), links (the conversation key is exactly the
  vendor's `telegram:<chat>` / `telegram:<chat>:<topic>`, so already-linked
  conversations stay the same conversations), inbound
  (`normalize`/`admit`/`intakeMedia`), outbound (`plan`/`send`), the provider's
  own media limits (1024 caption, 50 MB file) and two settings keys resolved
  env → default.
- The outbound plan reuses the vendor splitter
  (`splitTelegramPublicationText`), so the parts a connector send would deliver
  are the parts the direct integration delivers today — no second copy of the
  4,096-unit rule.
- Installation is one flag: `MYRMIDON_TELEGRAM_CHAT_PROVIDER` (off by default).
  Off — `installTelegramChannelConnector` registers nothing and the hub answers
  pass-through for `telegram`; on — the registry holds the factory. No vendor
  file is edited, the hub is not wired into the message lanes and the lifecycle
  is not called from anywhere in this step: the live board sends and receives
  Telegram exactly as before. Traffic switches in the later bridge step (the
  77-point map of OPE-6629), not here.
- The group gate stays shut without a configured bot: with the flag on but
  `MYRMIDON_TELEGRAM_BOT_USERNAME` unset, private chats are admitted and group
  turns are refused `not-addressed`.
- `telegram.myrmidon.test.ts` pins the flag semantics (unset/off/typo never
  installs), the contract shape against `CHANNEL_CONNECTOR_AREAS`, the key
  equality with the vendor, the admission gate, the media limits, the plan and
  part-by-part send through a fixture transport.

## changelog-ru

### CONNECTORS C: коннектор chat-provider-telegram (флаг установки, без переключения трафика) (1.6.6)

- Новый `server/src/myrmidon/channel-connectors/telegram.ts`: коннектор
  Telegram по контракту S1 — жизненный цикл (`start`/`stop`/`status` читают
  строку вендора, не переписывая её), ссылки (ключ диалога ровно вендорский,
  `telegram:<chat>` / `telegram:<chat>:<topic>`, поэтому уже привязанные
  диалоги остаются теми же диалогами), входящие
  (`normalize`/`admit`/`intakeMedia`), исходящие (`plan`/`send`), собственные
  лимиты провайдера (подпись 1024, файл 50 МБ) и два ключа настроек,
  разбираемых env → умолчание.
- План исходящих переиспользует вендорский делитель
  (`splitTelegramPublicationText`): части, которые отправил бы коннектор, —
  те же части, что прямая интеграция отправляет сегодня; второй копии правила
  про 4 096 единиц нет.
- Установка — один флаг: `MYRMIDON_TELEGRAM_CHAT_PROVIDER` (по умолчанию выкл).
  Выкл — `installTelegramChannelConnector` ничего не регистрирует, и хаб
  отвечает сквозным проходом для `telegram`; включён — реестр держит фабрику.
  Ни один вендорский файл не отредактирован, хаб не подведён к полосам сообщений
  и жизненный цикл ниоткуда не вызывается: боевая доска шлёт и принимает
  Telegram ровно как раньше. Трафик переключается в шаге моста (карта 77 точек
  подключения, OPE-6629), не здесь.
  Пока флаг включён, но `MYRMIDON_TELEGRAM_BOT_USERNAME` не задан, личные чаты
  проходят, а групповые ходы отвергаются как не адресованные боту.
- `telegram.myrmidon.test.ts` держит семантику флага (unset/off/опечатка —
  ничего не установлено), полноту формы контракта по
  `CHANNEL_CONNECTOR_AREAS`, равенство ключа вендорскому, ворот впуска, лимиты
  медиа, план и отправку по частям через тестовый транспорт.

## settings-en

| `MYRMIDON_TELEGRAM_CHAT_PROVIDER` | CONNECTORS-C | off | Installation flag of the chat-provider-telegram connector (OPE-4956 part C): `1`/`true`/`yes`/`on` registers the connector factory for the `telegram` provider in the channel connector registry. In this step nothing else consumes it: the hub is not wired into the message lanes, so traffic stays on the direct integration. The bridge step flips that | Any other value, unset or empty — nothing is registered, the hub answers pass-through for `telegram` and the vendor path keeps the endpoint. A typo never installs: it keeps the off side. Read at startup of the registration call, not per message |
| `MYRMIDON_TELEGRAM_BOT_USERNAME` | CONNECTORS-C | unset | For the Telegram connector (only when `MYRMIDON_TELEGRAM_CHAT_PROVIDER` is installed): the bot's username, with or without the leading `@`, used by the group-address gate — a group or channel message is admitted only when it mentions this name; private chats are admitted by definition | Unset — the connector admits no group turn (only DMs pass); the vendor group path is unaffected by this variable |

## settings-ru

| `MYRMIDON_TELEGRAM_CHAT_PROVIDER` | CONNECTORS-C | выкл | Флаг установки коннектора chat-provider-telegram (OPE-4956 ч.C): `1`/`true`/`yes`/`on` регистрирует фабрику коннектора для провайдера `telegram` в реестре коннекторов канала. На этом шаге больше никто его не потребляет: хаб не подведён к полосам сообщений, трафик остаётся на прямой интеграции. Шаг моста переключает это | Любое другое значение, пусто или не задано — ничего не регистрируется, хаб отвечает сквозным проходом для `telegram`, и вендорский путь сохраняет эндпоинт. Опечатка ничего не устанавливает: остаётся выключенная сторона. Читается при вызове регистрации, не на каждое сообщение |
| `MYRMIDON_TELEGRAM_BOT_USERNAME` | CONNECTORS-C | не задан | Для коннектора Telegram (только когда установлен `MYRMIDON_TELEGRAM_CHAT_PROVIDER`): имя пользователя бота, с `@` или без, по которому ворот адреса в группе впускает сообщение — групповой или канальный ход проходит, только если упоминает это имя; личные чаты проходят по определению | Не задан — коннектор не впускает ни одного группового хода (проходят только личные диалоги); на вендорский групповой путь эта переменная не влияет |
