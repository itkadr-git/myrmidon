---
divergence-section: Трек 4 — чаты и навыки
settings-section: Track 4 — chats and skills
---

## changelog-en

### Multi-agent addressing in the bridged Telegram chat (TG-MULTI-AGENT)

- A matching `@<token>` mention identifies the addressed agent. The `/to`
  command stores the selected addressee, shown by `/who` and `/agents`, but
  ordinary messages without a matching mention continue to the endpoint's
  assigned agent. No new setting: the addressing rides the X8b bridge (see
  [telegram-alias-addressing](../guides/telegram-alias-addressing.md)).

## changelog-ru

### Адресация любого агента в мостовом Telegram-чате (TG-MULTI-AGENT)

- Сообщение с подходящим `@<токен>` определяет адресуемого агента. Команда `/to` сохраняет выбранного адресата, которого показывают `/who` и `/agents`; обычные сообщения без подходящего упоминания продолжают идти назначенному агенту эндпоинта. Новых настроек нет: поведение работает поверх моста X8b ([telegram-alias-addressing](../guides/telegram-alias-addressing.ru.md)).

## divergence

| X9d | Documentation for the current X9c Telegram multi-agent contract: SETTINGS (EN+RU) describe `@`-mention routing, `/to` selection storage, reply format, context and safety gates. `/who` and `/agents` show the selection; unmentioned ordinary messages stay with the endpoint-assigned agent because `/to` is not an inbound fallback. | Docs only: EN+RU guides and SETTINGS rows; root README navigation links | TG-MULTI-AGENT, part D: docs verified against merged X9a/X9b/X9c implementation; no code changes | No (docs only) | X9d's separate runtime requirement remains open; update docs with that code if unmentioned-message routing is implemented | (PR) |

## settings-en

| — | X9c (X9d documentation row) | — (no variable) | In a bridged Telegram chat, a matching `@<alias>` mention routes to that same-company agent's standing Agent Chat conversation; the reply returns in-thread with the agent display-name prefix, and the first turn includes recent chat context. Only a leading matching token is removed from the message body. `/agents`, `/to <alias>`, and `/who` are implemented commands; `/to` stores the selected choice shown by `/who` and `/agents`, but it is not an inbound routing fallback, so a mention is required to address another agent in ordinary messages. X9d remains an open requirement for separate runtime work; this row documents only current X9c behavior. No new variable: this behavior rides the X8b bridge; see `guides/telegram-alias-addressing.md` | Off with the bridge: unset `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — vendor path without resolution, prefix, or commands. Unresolvable mentions go to the endpoint's assigned agent; unlinked senders are refused before resolution; in group topics only bot-addressed messages resolve. X9a/X9b/X9c in DIVERGENCE.md |

## settings-ru-append

<!-- section: Трек 4 — чаты и навыки -->

| — | X9c (строка документации X9d) | — (без переменной) | В мостовом Telegram-чате подходящее упоминание `@<алиас>` направляется в постоянную переписку Agent Chat агента той же компании; ответ возвращается в тред с префиксом отображаемого имени, а первый ход включает недавний контекст чата. Удаляется только совпавший ведущий токен. Команды `/agents`, `/to <алиас>` и `/who` реализованы; `/to` сохраняет выбор, который показывают `/who` и `/agents`, но не служит запасным адресатом входящей маршрутизации, поэтому для обращения к другому агенту в обычном сообщении нужно упоминание. X9d остаётся открытым требованием для отдельной runtime-работы; эта строка описывает только текущее поведение X9c. Новых переменных нет: поведение работает поверх моста X8b; см. `guides/telegram-alias-addressing.md` | При выключенном мосте: не задана `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — путь вендора без резолва, префикса и команд. Нераспознанное упоминание направляется назначенному на эндпоинт агенту; непривязанный отправитель получает отказ до резолва; в топиках групп резолвятся только сообщения, адресованные боту. X9a/X9b/X9c в DIVERGENCE.md |
