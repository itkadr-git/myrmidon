---
divergence-section: Трек 4 — чаты и навыки
settings-section: Track 4 — chats and skills
---

## changelog-en

### Telegram bridge texts follow the user's language (TG-LOCALE)

- Service prose of the bridged Telegram DM (command replies, statuses,
  refusals, the migration notice, the unlinked refusal) moved from hardcoded
  Russian literals to server-side locale catalogs
  (`server/src/myrmidon/agent-chat-bridge/locales/{en,ru}.ts`): EN is the
  base, RU keeps the pilot wording key for key. The linked board user's
  Settings → Language choice decides per message (read again on every
  command, no restart); English is the default.
- `MYRMIDON_TELEGRAM_DM_LANGUAGE` forces one language instance-wide — the
  only env knob, operator override; the Telegram private-chat command menu
  (one menu per bot) follows this instance decision, per-message replies
  follow the user.
- The Settings → Language screen shows the source of the bridge value
  (user preference vs environment force, with the forced language named),
  recomputed on every read; `GET /api/myrmidon/ui2/language/me` carries
  `telegramBridge`. The current-interface language switch in the account
  menu now persists to the same server preference row.
- Ratchet test forbids Cyrillic string literals in bridge sources outside
  the catalogs; acceptance tests prove an EN user gets English and an RU
  user Russian end to end (embedded Postgres), including the live switch of
  a preference taking effect on the next reply.

## changelog-ru

### Тексты Telegram-моста по языку пользователя (TG-LOCALE)

- Служебная проза бриджевой лички Telegram (ответы команд, статусы, отказы,
  уведомление о переходе, отказ непривязанному) вынесена из русских литералов
  в коде в файлы локализации на сервере
  (`server/src/myrmidon/agent-chat-bridge/locales/{en,ru}.ts`): EN — база, RU
  сохраняет пилотные формулировки ключ в ключ. Выбор языка пользователя в
  «Настройках → Язык» доски решает на каждое сообщение (читается заново при
  каждой команде, без перезапуска); по умолчанию — английский.
- `MYRMIDON_TELEGRAM_DM_LANGUAGE` принудительно ставит один язык на весь
  экземпляр — единственная env-переменная, переопределение оператора; меню
  команд личных чатов Telegram (одно меню на бота) следует решению
  экземпляра, ответы в чате — языку пользователя.
- Экран «Настройки → Язык» показывает источник значения моста (настройка
  пользователя против принуждения окружением, с названием закреплённого
  языка), пересчёт при каждом чтении; `GET /api/myrmidon/ui2/language/me`
  отдаёт `telegramBridge`. Переключатель языка в меню аккаунта текущего
  интерфейса теперь пишет ту же строку настройки на сервер.
- Тест-храповик запрещает кириллические строковые литералы в источниках
  моста вне каталогов; приёмочные тесты доказывают, что EN-пользователь
  получает английский, RU-пользователь — русский, включая живой переезд
  настройки на следующий ответ (embedded Postgres).

## divergence

| TG-LOCALE | Служебные тексты бриджевой лички Telegram — из файлов локализации (`server/src/myrmidon/agent-chat-bridge/locales/{en,ru,index}.ts`) на языке привязанного пользователя: EN по умолчанию, RU — пилотные формулировки; настройка `MYRMIDON_TELEGRAM_DM_LANGUAGE` принуждает один язык на экземпляр (включая меню команд: одно меню на бота); тест-храповик «нет кириллических литералов в мосте»; экран «Язык» показывает источник значения (`telegramBridge` в ответе `GET/PUT .../ui2/language/me`) | `server/src/services/chat-channels.ts` (точки вызова `myrmidon(X8e)`/`myrmidon(X8b)`: регистрация меню `setMyCommands` рендерит `telegramDmCommandsForLocale(telegramDmMenuLocale())`; `afterTelegramDmMessage` получает `boardUserId` для языка уведомления о переходе) + наши файлы `server/src/myrmidon/agent-chat-bridge/**`, `server/src/myrmidon/ui2-language/routes.ts`, `ui/src/ui2/i18n/**`, `ui/src/i18n/myrmidon-i18n.ts` | Тексты моста были русскими литералами в коде: англоязычный пользователь получал русские ответы; решение 1.7 — EN по умолчанию, у каждого своя локаль | `server/src/myrmidon/agent-chat-bridge/locales-ratchet.myrmidon.test.ts`, `locales.myrmidon.test.ts`, `commands/commands.myrmidon.test.ts` (случай 12c), `server/src/myrmidon/ui2-language/routes.myrmidon.test.ts` (источник значения), `server/src/__tests__/telegram-dm-command-menu.myrmidon.test.ts` | Никогда, наше поведение. При переносе вендора сверить метки `myrmidon(1.7-TG-LOCALE)` в `chat-channels.ts` | (этот PR) |

## settings-en

| `MYRMIDON_TELEGRAM_DM_LANGUAGE` | TG-LOCALE | unset — the linked board user's Settings → Language choice, English default | Forces one language (`en` or `ru`) for every bridged Telegram DM service text (commands, statuses, refusals, notices) and for the Telegram private-chat command menu, instance-wide. A forced-override knob for the operator: the user's own choice is decided in the interface without a restart (read per message); this variable overrides it everywhere. The Settings → Language screen shows this source when it is set | Unset, blank or not `en`/`ru` (case-insensitive) — no force. Read on every message and every menu registration — no restart |
