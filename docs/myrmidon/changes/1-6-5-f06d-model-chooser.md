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
- The list shows every chat model the agent's key may run, of every family, with no ceiling on the count;
  only non-chat models are dropped. "Chat" is decided by the mode the gateway declares for the model
  (`model_info.mode`: `chat`, `responses`, `completion`), which the cost sweep now stores with each model; for a
  model without a declared mode an id rule applies (embeddings, OCR, rerank, moderation, image/video/speech
  generation and recognition). The board's own `hindsight-*`/`-mem` models are dropped either way. Order:
  DashScope, then z.ai, then the other families, ids compared as numbers; the card's own models go through the
  same filter and stand in that order, not first. Family header lines are gone. The keyboard holds up to 98
  model buttons (Telegram's limit is 100 per message) plus "agent default"; with more models the rest are chosen
  by number or name from the complete list, and the reply says so.
- A model chosen for a native-provider card (`anthropic`, ...) from the gateway list is stored together with the
  provider that routes it (`custom`), so the run never sends the card's old provider with the new model; the
  card's own models keep its provider, and the pair is rolled back together if the profile apply fails.
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
- В списке все чат-модели, доступные ключу агента, всех семейств, без потолка по числу; отбрасываются только не-чат
  модели. «Чат» определяет режим, который объявляет сам шлюз (`model_info.mode`: `chat`, `responses`,
  `completion`), сборщик расходов теперь сохраняет его вместе с моделью; для модели без объявленного режима
  работает правило по id (эмбеддинги, OCR, rerank, модерация, генерация и распознавание картинок/видео/речи).
  Служебные `hindsight-*`/`-mem` отбрасываются в любом случае. Порядок: DashScope, затем z.ai, затем остальные
  семейства, числа в id сравниваются как числа; модели карточки проходят тот же фильтр и стоят в этом порядке, а
  не первыми. Строки-заголовки семейств убраны. На клавиатуре до 98 кнопок моделей (лимит Telegram — 100 на
  сообщение) и «по умолчанию у агента»; если моделей больше, остальные выбираются номером или именем из полного
  списка, и ответ об этом говорит.
- Модель из списка шлюза, выбранная для карточки с собственным провайдером (`anthropic` и т. п.), записывается
  вместе с провайдером, который её ведёт (`custom`), поэтому запуск никогда не шлёт старый провайдер карточки с
  новой моделью; собственные модели карточки сохраняют её провайдер, а при неудачном применении профиля пара
  откатывается вместе.
- Почему `/model` шлюзового агента показывал весь каталог шлюза: собственный список агента читался по секрету
  «ключ на агента», которым профиль бота не пользуется. Теперь читается ключ, который бот действительно шлёт
  (привязка карточки `MYRMIDON_BOT_LLM_API_KEY_ENV`, иначе общий секрет компании, затем секрет на агента), а
  откат на весь каталог пишется в журнал с кодом причины и называется в ответе.

## divergence

| 1.6.5-F06-D | Telegram `/model` и `/think`: список — все чат-модели в порядке каналов владельца (DashScope, z.ai, остальные), без заголовков семейств и без потолка (чат — по `model_info.mode` шлюза, для неизвестного режима правило по id; сборщик `litellm_models` сохраняет режим в `rates.mode`), на клавиатуре до 98 кнопок; provider согласуется с выбранной моделью (`providerOverrideForModel`); кнопки выбора (карточка без `interactionId` + токены `chat_actions` видов `chooser_list`/`chooser_pick`), выбор ответом числом/именем на сообщение со списком, выполнение исправленной команды (`/model`, `/think`, `/status`, `/help`, `/stop`, `/agents`, `/who`); собственный список шлюзового агента читается ключом, который бот действительно шлёт (привязка карточки → общий секрет компании → секрет на агента), причина отката на весь каталог — в журнале и в ответе | Наши файлы `server/src/myrmidon/agent-chat-bridge/{chooser-actions,gateway-model-catalog,bridge}.ts`, `.../commands/{models,index}.ts`, `.../locales/{en,ru}.ts`. Вендор с маркером `myrmidon(F06-D)`: `server/src/services/chat-channels.ts` (раскладка кнопок списка по рядам в `safeCardForPublication`; ветка `handleAction` для токенов `pcm:`; `replyToProviderMessageId` в вызове `handleTelegramDmCommand`; `runEditedBridgedCommand` перед обработкой записи жизненного цикла), `server/src/services/chat-publication-projection.ts` (вход `card` — карточка без интеракции, потолок 100 кнопок) | Жалоба владельца 09.10: `/model` в Telegram не работал — список мешал эмбеддинги и OCR, резал z.ai, не было выбора кнопкой и ответом, исправленная команда пропадала молча, а причина отката на весь каталог не называлась | `server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts` (блок `model chooser buttons, reply-pick and edited commands`), `server/src/myrmidon/agent-chat-bridge/commands/{commands,models}.myrmidon.test.ts`, `server/src/myrmidon/agent-chat-bridge/gateway-model-catalog.myrmidon.test.ts` | Никогда, наше поведение. Если у вендора появится выбор модели кнопками из чата — сверить и удалить куски `myrmidon(F06-D)`; ветку `pcm:` в `handleAction` и `runEditedBridgedCommand` снимать вместе с `chooser-actions.ts` | (этот PR) |
