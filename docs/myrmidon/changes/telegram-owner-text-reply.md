---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Owner text answer in Telegram closes the question (U2)

- The owner's text message in the standing Telegram chat with the bot now closes the owner decision the bot explained there, attributed to the owner, and the task's agent is woken with the answer. A reply to a bot message is bound to the decisions that exact message explained; without a reply one open decision closes, and with several the bot asks which one. A reply to a message that explains nothing closes nothing.

## changelog-ru

### Текстовый ответ владельца в Telegram закрывает вопрос (U2)

- Текстовое сообщение владельца в постоянном чате с ботом в Telegram теперь закрывает решение, которое бот объяснил в этом чате, от имени владельца, и агент задачи будится с ответом. Ответ (reply) на сообщение бота привязывается к решениям, которые объяснило именно это сообщение; без reply закрывается единственное открытое решение, а при нескольких бот переспрашивает, к какому относится ответ. Ответ на сообщение, которое ничего не объясняет, ничего не закрывает.

## divergence

| Track 4 — chats and skills | MYR-1.6.6-RC2 | The inbound Telegram ingest passes the owner's direct-chat message to the existing owner-reply handler (`handleTelegramOwnerReply` in `owner-reply/telegram-door.ts`), narrowed by the replied-to bot message. Works in the `via_bot` delivery mode only; the board-only rules for secrets and tool permissions are unchanged. | The owner answers a question in plain text in the same chat; the answer must be recorded on the board as the owner's. | `telegram-door.myrmidon.test.ts` | Remove the call from the inbound ingest in `chat-channels.ts`. | PR pending |
