# Telegram bridged chat: addressing any company agent with @<alias> or agent://UUID

> Русская версия: [Telegram-alias-addressing.ru](Telegram-alias-addressing.ru)

A bridged Telegram chat (a bot DM connected with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, or a group topic where the bot was
mentioned) can address another company agent with a matching `@`-mention in
an ordinary message. The message routes to that agent's own standing
conversation, and the reply returns in the same Telegram chat. An explicit `agent://UUID` determines the addressee before any `@`-mention. Otherwise, the first resolvable alias mention anywhere in the message determines the addressee. `/to` stores the chat's
selected addressee shown by `/who` and `/agents`; it is not an inbound routing
fallback; address another agent with an explicit ID or matching `@`-mention.

```
@gip recheck the estimate for section 3
```

Use the exact agent ID when the name is ambiguous:

```
agent://123e4567-e89b-12d3-a456-426614174000 recheck the estimate
```

No setting enables this: it rides the X8b bridge. When the variable is
unset, the vendor path is unchanged and nothing in this guide applies.

## Where the message goes

- The first resolvable `@`-mention anywhere in the message routes into
  **that agent's own** standing Agent Chat conversation with the same Telegram
  identity.
  `conversation_agent_id` is the addressed agent, while
  `conversation_user_id` stays `telegram:<board user id>`. The switch is
  per agent: a DM (or topic) that addressed one agent later addresses
  another one, and going back restores the earlier conversation — the
  history of each conversation is preserved in its own issue.
- `agent://UUID` has priority over every textual mention. It must identify one
  eligible agent in the endpoint's company; an accompanying `@name` is not
  used for selection.
- Malformed, unknown, foreign-company, hidden, terminated, or otherwise
  ineligible IDs, and messages containing multiple IDs, are refused without
  fallback to an alias, name, or endpoint agent.
- The addressed agent's reply is published **into the same Telegram
  thread** the message came from, prefixed with the agent's display name:
  `[GIS] here is the revised estimate…`.
- The first turn of an addressed agent quotes the recent messages of that
  Telegram chat, so the agent joins the conversation with context. The
  quote depth is governed by the cross-channel settings
  (`MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES` and siblings).
- Only a matching `@`-mention at the beginning of the message is removed
  from the turn's body. A matching mention later in the message still routes,
  and remains in the body.
- A message with no explicit ID and no resolvable `@`-token goes to the
  endpoint's assigned agent exactly as before the change, even when `/to` has
  stored a choice. Explicit IDs never use this fallback.

## What an alias is and where it lives

An alias is a short handle the operator picks per agent. Aliases live in
the agent card JSON — the `telegramAliases` string array in
`agents.metadata` (or `agents.adapter_config`):

```json
{ "telegramAliases": ["gip", "estimator"] }
```

Matching when resolving a mention:

Names, titles, and explicit or computed aliases match case-insensitively against
the complete token (letters, digits, underscore and hyphen). A prefix is not a
match: `@gip2` does not resolve as `@gip` unless `gip2` is itself an alias or
name. If multiple eligible agents match, the bridge refuses the ambiguous address.

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
| `/to <alias>` | Stores the chat's selected addressee, shown by `/who` and `/agents`; ordinary messages without an explicit ID or matching `@`-mention continue to the endpoint's assigned agent. `/to` with no argument clears the stored choice. |
| `/who` | Shows the current default addressee |

An unknown alias in `/to` answers with the list of valid ones.

## Where the records live

The addressing itself needs no new settings rows; the behavior and its
relation to the vendor code are recorded in
[DIVERGENCE.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/DIVERGENCE.md) (X9a, X9b), and the underlying bridge
settings in [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md) (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
