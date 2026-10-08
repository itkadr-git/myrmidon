# Agent question and confirmation cards delivered to the owner's Telegram

> Russian version: [owner-telegram-cards.ru.md](owner-telegram-cards.ru.md)

When an agent needs the owner's decision — a question card
(`ask_user_questions`) or a confirmation card (`request_confirmation`) — the
board shows the card on the task, and the owner answers it from the board UI.
If the company runs the Telegram DM bridge (X8b, see
[SETTINGS.md](../SETTINGS.md), `MYRMIDON_TELEGRAM_DM_CONVERSATIONS`), the same
card also reaches the owner's Telegram as a message from the bot that belongs
to the authoring agent. The owner can answer without opening the board.

## The delivery mode

How an owner decision reaches the owner's Telegram is the instance's
owner-delivery mode (`instance_settings.general[ownerDelivery]`, read with
`GET /api/myrmidon/owner-delivery`, changed with
`PATCH /api/myrmidon/owner-delivery`, `{ "mode": ... }`, instance
administrator; the Company Settings screen "Owner Telegram delivery" shows the
same three choices). The modes:

- `via_bot` — the default; an instance that never stored the setting is in
  this mode. No card with buttons is published to the owner's Telegram at
  all. Instead the agent that raised the question is woken on the same task
  with the open decision in its prompt and writes the owner one plain bot
  message that explains what to decide, why, each option with its
  consequence, and a recommendation. The owner answers in the chat with
  ordinary text, and the agent records the decision on the card (see
  "The `via_bot` mode" below).
- `owner_decisions_only` — only the cards that wait for the owner are
  delivered as cards with buttons. The rest of this page describes this
  card delivery.
- `all` — every card an agent raises is delivered.

An explicitly saved `owner_decisions_only` or `all` keeps its behaviour;
only instances without a stored mode follow the new default.

## When a card is delivered to Telegram

In the `via_bot` mode a card never reaches the owner's Telegram — the bot
message replaces it. In the other two modes, all of the following must hold:

1. The card is a pending `ask_user_questions` or `request_confirmation`
   created by an agent (not by a user or the system). Other interaction kinds
   stay board-only.
2. The task the card belongs to has **no chat-thread binding of its own** —
   the vendor path did not find any live conversation bound to that task. A
   task's own chat bindings always win; the Telegram owner delivery is
   additive and never mirrors a card into a second conversation.
3. The task itself is not an Agent Chat conversation (it has no
   `conversationAgentId`/`conversationUserId`): cards of a chat-native task
   already live in that conversation.
4. The task names an owner: its responsible user, otherwise its creator.
5. That owner has a **live standing Telegram DM conversation with the same
   agent** that authored the card (the X8b bridge): the conversation is a
   direct message in state `active` or `waiting`, and the conversation
   identity is `telegram:<board user id>` of the owner.
6. The conversation runs on a Telegram endpoint whose **immutable assigned
   agent is the card's author**, in `automatic` publication mode and status
   `active` or `verifying`.

Rule 6 is the "a card only ever speaks through its own agent's bot" rule:
a card created by agent A is never delivered through a bot endpoint assigned
to agent B.

## What the owner sees and how the answer lands

The card arrives in the owner's Telegram DM with the authoring agent's bot as
a message with the card text and answer affordances (buttons for closed
shapes, a link to the task otherwise — the same projection the vendor uses for
chat-bound tasks). The owner's reply is recorded against the same card on the
board, and the task's run continues as if the card had been answered from the
board UI.

The card keeps belonging to its own task — the owner's Telegram DM has a
different task of its own (the conversation issue), and the card is only
projected into that conversation. The board resolves a tap on a button by the
card's interaction id across the company's tasks (the same-task lookup is
tried first), so the answer always lands on the task the card was created on,
never on the conversation's own task. All company and actor checks are
unchanged.

## When no delivery happens

If any condition above is not met, the card stays on the board only. In
particular:

- the owner has no standing Telegram DM with the authoring agent (the bridge
  is off for that endpoint, the DM was never started, or it is not
  `active`/`waiting`) — the card is not delivered anywhere outside the board;
- the task already has a live chat binding — the vendor path publishes the
  card there, and the owner delivery adds nothing;
- the card was authored by a user or the system — no Telegram delivery.

There is no fallback to another agent's bot and no queueing "until the owner
opens a DM": delivery is best-effort at the moment the card is enqueued.

## The `via_bot` mode

In the default `via_bot` mode the owner never sees a card with buttons: the
decision arrives as an ordinary message from the agent's bot, and the owner
answers it with ordinary text in the same Telegram chat.

- After an agent creates a question or confirmation that only the owner can
  decide, the agent is woken on the same task with the open decision in its
  prompt and must explain it to the owner in one message: what to decide,
  why it matters now, each option with its consequence, and a
  recommendation. One message per question; several open questions for the
  same owner are covered by one summary message, not a stream.
- The message is written into the owner's standing Telegram DM with the
  authoring agent (`POST /api/myrmidon/owner-message`). Only the author of
  an open owner decision may write it; a second message about an
  already-explained question is refused while the owner has not answered.
- The owner's text answer arrives in the same chat marked as a reply to the
  open decision. The agent then closes the card on the board in the owner's
  name (`POST /api/myrmidon/owner-message/resolve`) — and only by pointing to
  the id of the owner's own message in that chat, written after the
  explanation (`ownerReplyCommentId`). An unclear or partial answer closes
  nothing: the agent asks one short clarifying question in the chat and
  waits.
- The card stays on the board as the record of the decision. Confirmations
  that authorize a tool action, a secret or a connection are never closed
  from a chat reply; they stay explicit decisions on the board.

## Settings involved

- `ownerDelivery` (instance settings, Company Settings → "Owner Telegram
  delivery") — the delivery mode; see "The delivery mode" above.
- `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — enables the X8b bridge per Telegram
  endpoint (comma-separated endpoint ids or `*`); see
  [SETTINGS.md](../SETTINGS.md). The owner-delivery extension needs no setting
  of its own: it reuses the standing conversations the bridge maintains.

## Source of truth

- Mode contract: `packages/shared/src/myrmidon-owner-delivery.ts`
  (`OWNER_DELIVERY_MODES`, `ownerDeliveryAllowsCard`); settings read/write:
  `server/src/myrmidon/owner-delivery/settings.ts`
  (marker `myrmidon(1.6.5-OWNER-VIA-BOT)`).
- Bot message and owner-reply resolution:
  `server/src/myrmidon/owner-delivery/owner-message.ts`,
  `server/src/myrmidon/owner-delivery/routes.ts`.
- Call site for card delivery: `server/src/services/chat-interaction-publications.ts`
  (marker `myrmidon(U2)`, after the vendor binding lookup).
- Binding search: `server/src/myrmidon/owner-delivery/telegram-owner-bindings.ts`.
- Callback resolution: `server/src/myrmidon/owner-delivery/callback-interaction-lookup.ts`.
- Behaviour record: [../DIVERGENCE.md](../DIVERGENCE.md), row U2.
