# Agent question and confirmation cards delivered to the owner's Telegram

> Russian version: [owner-telegram-cards.ru.md](owner-telegram-cards.ru.md)

When an agent needs the owner's decision — a question card
(`ask_user_questions`) or a confirmation card (`request_confirmation`) — the
board shows the card on the task, and the owner answers it from the board UI.
If the company runs the Telegram DM bridge (X8b, see
[SETTINGS.md](../SETTINGS.md), `MYRMIDON_TELEGRAM_DM_CONVERSATIONS`), the same
card also reaches the owner's Telegram as a message from the bot that belongs
to the authoring agent. The owner can answer without opening the board.

## Which cards reach the owner's Telegram (the owner-delivery mode)

Not every card an agent raises is mirrored to the owner's Telegram. An
instance setting, `ownerDelivery` in `instance_settings.general`, picks the
delivery mode:

- `owner_decisions_only` — **the default** (and the mode of every instance
  that never saved the setting): the owner's Telegram receives only cards
  addressed to a human — cards whose effective resolver policy is
  `human_only`, or cards whose addressee user is the task owner (its
  responsible user, otherwise its creator). Cards addressed to an agent and
  purely operational agent-to-agent confirmations (resolver policy `anyone`
  or `not_creator` with no human addressee) stay on the board only.
- `all` — every card an agent raises is delivered, the pre-filter behaviour.

Read the mode with `GET /api/myrmidon/owner-delivery`, change it with
`PATCH /api/myrmidon/owner-delivery` (`{ "mode": "owner_decisions_only" }` or
`{ "mode": "all" }`; any company member may read, changing it needs the
instance administrator role). The same choice is a switch on the company
settings screen: **Company settings → Owner Telegram delivery**.

## When a card is delivered to Telegram

All of the following must hold:

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
chat-bound tasks). The text opens with a short human-readable header line
(`Нужно ваше решение: …`) built from the interaction's own fields — the
question or confirmation prompt, never internal ids — so the owner sees what
is being asked before the raw card text. Cards the vendor path delivers to a
task's own chat thread keep the vendor text unchanged. The owner's reply is
recorded against the same card on the board, and the task's run continues as
if the card had been answered from the board UI.

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

- the card is filtered out by the owner-delivery mode (see "Which cards
  reach the owner's Telegram" above) — with the default
  `owner_decisions_only` mode, cards addressed to an agent never leave the
  board;
- the owner has no standing Telegram DM with the authoring agent (the bridge
  is off for that endpoint, the DM was never started, or it is not
  `active`/`waiting`) — the card is not delivered anywhere outside the board;
- the task already has a live chat binding — the vendor path publishes the
  card there, and the owner delivery adds nothing;
- the card was authored by a user or the system — no Telegram delivery.

There is no fallback to another agent's bot and no queueing "until the owner
opens a DM": delivery is best-effort at the moment the card is enqueued.

## Settings involved

- `ownerDelivery` (instance settings, `instance_settings.general`) — which
  cards are mirrored to the owner's Telegram; see "Which cards reach the
  owner's Telegram" above. Read/write via `GET/PATCH
  /api/myrmidon/owner-delivery`, or the switch in Company settings.
- `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` — enables the X8b bridge per Telegram
  endpoint (comma-separated endpoint ids or `*`); see
  [SETTINGS.md](../SETTINGS.md). The owner-delivery extension reuses the
  standing conversations the bridge maintains.

## Source of truth

- Mode contract: `packages/shared/src/myrmidon-owner-delivery.ts`
  (`OWNER_DELIVERY_MODES`, `ownerDeliveryAllowsCard`).
- Mode storage: `server/src/myrmidon/owner-delivery/settings.ts`;
  `GET/PATCH` routes in `server/src/myrmidon/owner-delivery/routes.ts`
  (marker `myrmidon(1.6.5-OWNER-DM-FILTER)`).
- Call site: `server/src/services/chat-interaction-publications.ts`
  (marker `myrmidon(U2)`, after the vendor binding lookup; the mode filter
  lives inside the binding search).
- Binding search: `server/src/myrmidon/owner-delivery/telegram-owner-bindings.ts`.
- Human-readable card prefix: `server/src/myrmidon/owner-delivery/owner-card-text.ts`.
- Callback resolution: `server/src/myrmidon/owner-delivery/callback-interaction-lookup.ts`.
- Behaviour record: [../DIVERGENCE.md](../DIVERGENCE.md), row U2.
