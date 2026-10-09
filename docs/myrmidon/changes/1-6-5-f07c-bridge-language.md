---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Default language of the bridged Telegram DM comes from the instance (1.6.5 F-07 part C)

- The bridged Telegram DM now has an instance-wide default language:
  `instance_settings.general.bridgeLanguage`, changed on Settings → Language
  (or `GET`/`PATCH /api/myrmidon/bridge-language`). `GET` needs ordinary board
  access, `PATCH` needs instance admin rights and writes an `issue.updated`
  activity entry; the value is read through a 5-second cache, so a saved
  change applies from the next reply without a restart.
- The resolution order of the language a chat is answered in is now:
  `MYRMIDON_TELEGRAM_DM_LANGUAGE` (the operator's force) → the linked board
  user's Settings → Language choice → the instance default → English. The
  Telegram private-chat command menu follows the same order.
- `GET`/`PUT /api/myrmidon/ui2/language/me` reports the source of the value
  the chat really uses (`telegramBridge.source` = `user` | `environment` |
  `instance` | `default`, with the forced and instance values alongside), and
  the Settings → Language panel names that source instead of describing every
  unforced instance as the user's own choice.
- The refusal texts for a model or reasoning effort that the adapter does not
  serve now name the adapter, the reason and where the value is changed (the
  agent card) in both locales, instead of a bare "unavailable for adapter X".

## changelog-ru

### Язык моста по умолчанию берётся из инстанса (1.6.5 F-07 часть C)

- У мостовой лички Telegram появился язык по умолчанию на весь инстанс:
  `instance_settings.general.bridgeLanguage`, меняется на экране
  «Язык» / Settings → Language (или `GET`/`PATCH /api/myrmidon/bridge-language`).
  `GET` требует обычного доступа к доске, `PATCH` — прав администратора
  инстанса и пишет запись в журнал активности (`issue.updated`); значение
  читается через кэш на 5 секунд, поэтому сохранённая правка действует со
  следующего ответа, без перезапуска.
- Порядок выбора языка, на котором отвечает чат, теперь такой:
  `MYRMIDON_TELEGRAM_DM_LANGUAGE` (принуждение оператора) → выбор связанного
  пользователя доски на экране «Язык» → язык инстанса по умолчанию →
  английский. Меню команд приватного чата Telegram следует тому же порядку.
- `GET`/`PUT /api/myrmidon/ui2/language/me` сообщает источник значения,
  которым реально отвечает чат (`telegramBridge.source` = `user` |
  `environment` | `instance` | `default`, рядом — принуждённое и
  инстансовое значения), а панель «Язык» называет этот источник вместо того,
  чтобы описывать любой непринуждённый случай как выбор самого пользователя.
- Тексты отказа для модели или уровня рассуждений, которые адаптер не
  обслуживает, теперь называют адаптер, причину и место правки (карточка
  агента) в обоих языках, вместо голого «недоступно для адаптера X».

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| TG-LOCALE-C | Язык моста по умолчанию — язык компании/инстанса (часть C эпика 1.6.5 F-07, продолжение ряда TG-LOCALE): `instance_settings.general.bridgeLanguage` хранит язык по умолчанию для всей мостовой лички Telegram, меняется на экране «Язык» (`GET`/`PATCH /api/myrmidon/bridge-language`; чтение — доступ к доске, запись — только администратор инстанса, с записью в журнал активности `issue.updated`; кэш 5 с, без перезапуска). Порядок выбора языка чата: `MYRMIDON_TELEGRAM_DM_LANGUAGE` → выбор пользователя доски → язык инстанса → английский; меню команд следует тому же порядку. `GET`/`PUT /api/myrmidon/ui2/language/me` отдаёт источник значения (`telegramBridge.source` = `user`/`environment`/`instance`/`default`), панель «Язык» его называет. Ключ `bridgeLanguage` в `general` сохраняется при записи остальных общих настроек (иначе PATCH-обёртка вендора вычёркивает незнакомый ключ). Тексты отказа «модель/уровень рассуждений недоступны» в обоих каталогах называют адаптер, причину и место правки | Наши файлы: `packages/shared/src/myrmidon-bridge-language.ts`, `server/src/myrmidon/bridge-language/*`, `ui/src/ui2/i18n/{api.ts,LanguageSettingsPanel.tsx}`; в вендоре помечены `myrmidon(1.6.5-TG-LOCALE-C)`: `packages/shared/src/{index.ts,validators/instance.ts}`, `server/src/app.ts`, `server/src/services/{instance-settings.ts,chat-channels.ts}`, `server/src/myrmidon/agent-chat-bridge/locales/{index.ts,en.ts,ru.ts}`, `server/src/myrmidon/ui2-language/{service.ts,routes.ts}` | Эпик 1.6.5 F-07 часть C: у оператора не было способа задать язык бота для всей компании, и каждый член доски, не выбравший язык, получал английский; источник значения в интерфейсе был один — «выбор пользователя» | `server/src/myrmidon/bridge-language/bridge-language.myrmidon.test.ts`, `server/src/myrmidon/agent-chat-bridge/locales.myrmidon.test.ts` (порядок и источник), `server/src/myrmidon/ui2-language/routes.myrmidon.test.ts` (источник значения, инстансовый случай), `ui/src/ui2/i18n/catalog-parity.myrmidon.test.ts` (паритет ключей) | Никогда, наше поведение. Уходит вместе с рядом TG-LOCALE: при переносе вендора сверить метки `myrmidon(1.6.5-TG-LOCALE-C)` | (этот PR) |