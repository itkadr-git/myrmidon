# Telegram bridged chat: addressing any company agent with @<alias>

> Русская версия: [telegram-alias-addressing.ru.md](telegram-alias-addressing.ru.md)

A bridged Telegram chat (a bot DM connected with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, or a group topic where the bot was
mentioned) can address another company agent with a matching `@`-mention in
an ordinary message. The message routes to that agent's own standing
conversation, and the reply returns in the same Telegram chat. An alias
mentioned later in the message is ordinary text. `/to` stores the chat's
selected addressee shown by `/who` and `/agents`; it is not an inbound routing
fallback, so ordinary messages still need a matching `@`-mention to address
another agent.

```
@gip recheck the estimate for section 3
```

No setting enables this: it rides the X8b bridge. When the variable is
unset, the vendor path is unchanged and nothing in this guide applies.

## Where the message goes

- A leading `@`-token that resolves to an agent of the company routes into
  **that agent's own** standing Agent Chat conversation with the same Telegram
  identity. A token later in the message is ordinary text and does not route.
  `conversation_agent_id` is the addressed agent, while
  `conversation_user_id` stays `telegram:<board user id>`. The switch is
  per agent: a DM (or topic) that addressed one agent later addresses
  another one, and going back restores the earlier conversation — the
  history of each conversation is preserved in its own issue.
- The addressed agent's reply is published **into the same Telegram
  thread** the message came from, prefixed with the agent's display name:
  `[GIS] here is the revised estimate…`.
- The first turn of an addressed agent quotes the recent messages of that
  Telegram chat, so the agent joins the conversation with context. The
  quote depth is governed by the cross-channel settings
  (`MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES` and siblings).
- The leading `@<alias>` token is removed from the turn's body — it has
  already routed the message. Mentions later in the message remain ordinary
  text and do not route.
- A message with no resolvable `@`-token goes to the endpoint's assigned
  agent exactly as before the change, even when `/to` has stored a choice.
  To address another agent, include a matching `@`-mention.

## What an alias is and where it lives

An alias is a short handle the operator picks per agent. Aliases live in
the agent card JSON — the `telegramAliases` string array in
`agents.metadata` (or `agents.adapter_config`):

```json
{ "telegramAliases": ["gip", "estimator"] }
```

Matching when resolving a mention, in priority order:

1. exact alias (case-insensitive; the longest alias wins when one alias is
   a prefix of another, so `@gip2` does not resolve as `@gip`),
2. the agent's name,
3. the agent's title.

Only agents of the **same company** as the endpoint are addressable — an
alias of another company's agent never resolves.

## Who may address an agent

Addressing follows the X8b identity gate: it applies only when the
Telegram sender resolves to a linked board user of the instance. An
unlinked sender is answered by the bridge's refusal path before any
resolution runs. In group topics, a message resolves an addressee only
when it addressed the bot — the vendor's `requireMention` gate drops the
rest.

## Commands

| Command | What it does |
|---|---|
| `/agents` | Lists the company's agents with their aliases |
| `/to <alias>` | Stores the chat's selected addressee, shown by `/who` and `/agents`; ordinary messages without a matching `@`-mention continue to the endpoint's assigned agent. `/to` with no argument clears the stored choice. |
| `/who` | Shows the current default addressee |

An unknown alias in `/to` answers with the list of valid ones.

## Where the records live

The addressing itself needs no new settings rows; the behavior and its
relation to the vendor code are recorded in
[DIVERGENCE.md](../DIVERGENCE.md) (X9a, X9b), and the underlying bridge
settings in [SETTINGS.md](../SETTINGS.md) (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
