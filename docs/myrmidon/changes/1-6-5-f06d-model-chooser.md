---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Telegram `/model` and `/think`: buttons, reply-pick, edited commands, a correct model list (F06-D)

- A plain `/model` (or `/think`) in a bridged Telegram DM answers with a card of inline buttons, two to a row,
  one per listed choice (the current one marked `✓`) and an "agent default" button. A press applies the choice
  exactly like `/model <name>` does (the value is resolved against the live list again, a running reply and the
  reasoning-effort policy still refuse, a gateway agent's profile is applied) and the bot confirms once. A
  second press, a press by anyone but the conversation's own linked person, or a press under another message
  changes nothing.
- A reply to a list message with its number (`2`), a name (`glm-5.3`) or `default` picks from it, no command
  needed; any other reply goes to the agent as before.
- An edited `/model …`, `/think …`, `/status`, `/help`, `/stop`, `/agents` or `/who` runs as a command instead
  of ending as a silently filtered lifecycle row. `/new`, `/plan`, `/accept` and `/reject` are never re-run from
  an edit.
- The list shows chat models only (embeddings, OCR, speech, rerank and the board's own `hindsight-*`/`-mem`
  models are dropped, short tokens only as whole id segments), ordered DashScope, then z.ai, then the other
  families, ids compared as numbers; the card's own models stand in that order, not first. The owner-ranked
  families are never cut by the screen cap (up to 30 lines); the rest fills the 20 lines and the reply says how
  many were left out. Family header lines are gone.
- Why a gateway agent's `/model` kept listing the whole gateway catalog: the agent's own list was read with a
  per-agent key secret the bot profile never uses. It now reads the key the bot really sends (the card's own
  binding of `MYRMIDON_BOT_LLM_API_KEY_ENV`, else the shared company secret, then the per-agent secret), and a
  fallback to the whole catalog is logged with its reason code and named in the reply.

## changelog-ru

### Telegram `/model` и `/think`: кнопки, выбор ответом, исправленные команды, верный список моделей (F06-D)

- Простой `/model` (или `/think`) в мостовом личном чате Telegram отвечает карточкой с inline-кнопками по две
  в ряд: по кнопке на каждый показанный вариант (текущий отмечен `✓`) и кнопка «по умолчанию у агента». Нажатие
  применяет выбор так же, как `/model <имя>` (значение заново сверяется с живым списком, идущий ответ и политика
  глубины рассуждений по-прежнему отказывают, профиль шлюзового агента применяется), бот подтверждает один раз.
  Повторное нажатие, нажатие не привязанным владельцем диалога или под другим сообщением ничего не меняет.
- Ответ на сообщение со списком номером (`2`), именем (`glm-5.3`) или `default` выбирает из него, команда не
  нужна; любой другой ответ уходит агенту, как раньше.
- Исправленные `/model …`, `/think …`, `/status`, `/help`, `/stop`, `/agents`, `/who` выполняются как команды, а
  не оканчиваются молча отфильтрованной записью жизненного цикла. `/new`, `/plan`, `/accept` и `/reject` из
  правки не выполняются никогда.
- В списке только чат-модели (эмбеддинги, OCR, речь, rerank и служебные `hindsight-*`/`-mem` отброшены, короткие
  токены считаются только целым сегментом id), порядок: DashScope, затем z.ai, затем остальные семейства, числа
  в id сравниваются как числа; модели карточки стоят в этом же порядке, а не первыми. Семейства из политики
  владельца не режутся потолком экрана (до 30 строк), остальные заполняют 20 строк, а ответ говорит, сколько
  скрыто. Строки-заголовки семейств убраны.
- Почему `/model` шлюзового агента показывал весь каталог шлюза: собственный список агента читался по секрету
  «ключ на агента», которым профиль бота не пользуется. Теперь читается ключ, который бот действительно шлёт
  (привязка карточки `MYRMIDON_BOT_LLM_API_KEY_ENV`, иначе общий секрет компании, затем секрет на агента), а
  откат на весь каталог пишется в журнал с кодом причины и называется в ответе.

## divergence

| 1.6.5-F06-D | Telegram `/model` и `/think`: список — только чат-модели в порядке каналов владельца (DashScope, z.ai, остальные), без заголовков семейств, с потолком экрана и счётчиком скрытых; кнопки выбора (карточка без `interactionId` + токены `chat_actions` видов `chooser_list`/`chooser_pick`), выбор ответом числом/именем на сообщение со списком, выполнение исправленной команды (`/model`, `/think`, `/status`, `/help`, `/stop`, `/agents`, `/who`); собственный список шлюзового агента читается ключом, который бот действительно шлёт (привязка карточки → общий секрет компании → секрет на агента), причина отката на весь каталог — в журнале и в ответе | Наши файлы `server/src/myrmidon/agent-chat-bridge/{chooser-actions,gateway-model-catalog,bridge}.ts`, `.../commands/{models,index}.ts`, `.../locales/{en,ru}.ts`. Вендор с маркером `myrmidon(F06-D)`: `server/src/services/chat-channels.ts` (раскладка кнопок списка по рядам в `safeCardForPublication`; ветка `handleAction` для токенов `pcm:`; `replyToProviderMessageId` в вызове `handleTelegramDmCommand`; `runEditedBridgedCommand` перед обработкой записи жизненного цикла), `server/src/services/chat-publication-projection.ts` (вход `card` — карточка без интеракции, потолок 32 кнопки) | Жалоба владельца 09.10: `/model` в Telegram не работал — список мешал эмбеддинги и OCR, резал z.ai, не было выбора кнопкой и ответом, исправленная команда пропадала молча, а причина отката на весь каталог не называлась | `server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts` (блок `model chooser buttons, reply-pick and edited commands`), `server/src/myrmidon/agent-chat-bridge/commands/{commands,models}.myrmidon.test.ts`, `server/src/myrmidon/agent-chat-bridge/gateway-model-catalog.myrmidon.test.ts` | Никогда, наше поведение. Если у вендора появится выбор модели кнопками из чата — сверить и удалить куски `myrmidon(F06-D)`; ветку `pcm:` в `handleAction` и `runEditedBridgedCommand` снимать вместе с `chooser-actions.ts` | (этот PR) |
