---
divergence-section: Трек 4 — чаты и навыки
settings-section: Track 4 — chats and skills
---

## changelog-en

### Multi-agent addressing in the bridged Telegram chat (TG-MULTI-AGENT)

- A message in a bridged Telegram chat (bot DM or a group topic that
  addressed the bot) whose `@<token>` matches an alias, name or title of a
  same-company agent routes into that agent's own standing Agent Chat
  conversation, and the reply returns into the same Telegram thread
  prefixed with the agent's display name. Aliases are the
  `telegramAliases` string array of the agent card JSON; the leading token
  is dropped from the turn body, and the first turn of the addressed
  agent quotes the chat's recent messages. Linked-identity,
  same-company and mention gates apply. The management commands
  `/agents`, `/to <alias>`, `/who` follow the part B contract. No new
  setting: the addressing rides the X8b bridge
  ([telegram-alias-addressing](guides/telegram-alias-addressing.md)).

## changelog-ru

### Адресация любого агента в мостовом Telegram-чате (TG-MULTI-AGENT)

- Сообщение в мостовом Telegram-чате (личка бота или топик группы,
  адресованный боту), чей `@<токен>` совпал с алиасом, именем или
  должностью агента той же компании, уходит в собственную постоянную
  переписку Agent Chat этого агента, а ответ возвращается в тот же
  Telegram-тред с префиксом отображаемого имени агента. Алиасы — массив
  строк `telegramAliases` в JSON-карточке агента; ведущий токен вырезается
  из тела хода, первый ход адресованного агента цитирует недавние
  сообщения чата. Действуют гейты привязанной идентичности, той же
  компании и упоминания. Команды управления `/agents`, `/to <алиас>`,
  `/who` следуют контракту части B. Новых настроек нет: адресация едет
  поверх моста X8b
  ([telegram-alias-addressing](guides/telegram-alias-addressing.ru.md)).

## divergence

| X9d | Документация адресации `@<alias>` (X9a/X9b) без новой переменной: строка «—» в Track 4 SETTINGS (EN+RU) описывает поведение адресации — маршрутизация в собственную переписку адресованного агента, префикс `[<имя>]`, цитата контекста (настройки X8d), вырезание ведущего `@`-токена, гейты идентичности/компании/requireMention — и команды `/agents`, `/to`, `/who` по контракту X9c (часть B; при расхождении после слияния — отдельная правка). Гайд EN+RU `docs/myrmidon/guides/telegram-alias-addressing{,.ru}.md`; строки реестра X9a (#407) и X9b (#424) уже влиты | Только доки: `docs/myrmidon/SETTINGS.md`, `docs/myrmidon/SETTINGS.ru.md` (по одной строке в Треке 4), `docs/myrmidon/guides/telegram-alias-addressing.md` + `.ru.md`, `docs/myrmidon/README.md` (строка в таблице гайдов) | Задача 1.6.1 TG-MULTI-AGENT, часть D: каждое поведение в доках сверено со слитым кодом X9a/X9b; код не пишется | Нет (доки; строк X9c/B в коде на момент правки ещё нет — команды задокументированы по контракту) | Никогда, наше поведение. При переносе вендора доки следуют за кодом X9a/X9b/X9c; после слияния части B сверить имена команд `/agents`/`/to`/`/who` и поправить строку SETTINGS и гайд при расхождении | (PR) |

## settings-en

| — | X9a/X9b (X9d row) | — (no variable) | `@<alias>` addressing in a bridged Telegram chat: a message from a linked board user whose leading `@`-token (or any `@`-token in the text) matches an alias, name or title of a **same-company** agent routes into that agent's own standing Agent Chat conversation (same `conversation_user_id`), the reply returns into the same Telegram thread prefixed `[<display name>]`, the first turn quotes the chat's recent messages (X8d settings), and the leading token is dropped from the turn body. Aliases live in the agent card (`telegramAliases` array in `agents.metadata`/`adapter_config`). Commands `/agents`, `/to <alias>`, `/who` (part B contract) manage the default addressee from the chat. No new variable: riding the X8b bridge, the addressing is on exactly when the bridge is; see the guide `guides/telegram-alias-addressing.md` | Off with the bridge: unset `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — the vendor path is byte for byte, no resolution, no prefix, no commands. An unresolvable token goes to the endpoint's assigned agent; an unlinked sender is refused before resolution; in group topics only bot-addressed messages resolve. X9a/X9b in DIVERGENCE.md, PRs #407/#424 |

## settings-ru-append

<!-- section: Трек 4 — чаты и навыки -->

| — | X9a/X9b (строка X9d) | — (без переменной) | Адресация `@<алиас>` в мостовом Telegram-чате: сообщение связанного пользователя доски, чей ведущий `@`-токен (или любой `@`-токен в тексте) совпал с алиасом, именем или должностью агента **той же компании**, уходит в собственную постоянную переписку Agent Chat этого агента (тот же `conversation_user_id`), ответ возвращается в тот же Telegram-тред с префиксом `[<отображаемое имя>]`, первый ход цитирует недавние сообщения чата (настройки X8d), а ведущий токен вырезается из тела хода. Алиасы живут в карточке агента (массив `telegramAliases` в `agents.metadata`/`adapter_config`). Команды `/agents`, `/to <алиас>`, `/who` (контракт части B) управляют адресатом по умолчанию прямо из чата. Переменной нет: адресация едет поверх моста X8b и включена ровно тогда, когда включён мост; гайд — `guides/telegram-alias-addressing.md` | Выключается вместе с мостом: не заданная `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — путь вендора байт в байт, без резолва, префикса и команд. Нерезолвящийся токен идёт назначенному на эндпоинт агенту; непривязанный отправитель получает отказ до резолва; в топиках групп резолвятся только сообщения, адресованные боту. X9a/X9b в DIVERGENCE.md, PR #407/#424 |
