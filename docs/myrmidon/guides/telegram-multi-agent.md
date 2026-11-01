# Addressing agents from one Telegram chat

> Russian version: [telegram-multi-agent.ru.md](telegram-multi-agent.ru.md)

One bridged Telegram chat can address another agent with a matching `@`-mention in an ordinary message. `/to` stores a selected addressee shown by `/who` and `/agents`; ordinary messages without a matching mention continue to the endpoint's assigned agent.

- **A `@`-mention in the message text** routes that one message to the mentioned agent; the reply comes back in the same chat with the agent's display name in brackets, like `[Hypotheses] …`.
- **The `/to` command** stores the chat's selected addressee, which `/who` and `/agents` display. It does not change ordinary-message routing: without a matching `@`-mention, messages continue to the endpoint's assigned agent.

## Aliases

An alias is a short handle for an agent, stored in the agent card as `telegramAliases` — a list of strings in the card JSON (`metadata` first, then `adapter_config`; both are only read). Matching is case-insensitive; the same alias works with or without the `@` in `/to`.

When two agents could match, an alias beats a name, and a name beats a title.

Setting or changing aliases is a card edit by an administrator — the card's
**Telegram** section edits them right in the UI
([agent-telegram-card.md](agent-telegram-card.md)); there is no chat command
for it. While the list is empty, the bridge answers to a default alias
computed from the agent name (the last dash-separated segment, lower-cased).

## `/agents` — who can be addressed

Lists the company's agents that this chat may address: display name and aliases, one agent per line, the current addressee marked `current addressee`. Agents in `terminated` or `pending_approval` status are never listed and cannot be addressed. The list holds at most 60 agents.

If the company has no addressable agents, the reply says so.

## `/to` — store the selected addressee

- `/to <alias>` — stores that agent as the chat's selected addressee until the next `/to`. The reply confirms the choice and aliases. Choosing the already selected agent confirms it is set.
- `/to` without an argument — clears the stored choice. If no choice was set, the reply names the chat's assigned agent.
- An unknown alias answers with the list of available aliases (or, when no aliases are set at all, points to `/agents`).

The choice is stored in the conversation issue's `assignee_adapter_overrides` JSON column under the key `telegramStickyAgentId` — the same column `/model` and `/think` use, merged with their values; the `adapterConfig` key is untouched, so choosing an addressee never resets the chat's model session. Each change is recorded in the activity log as `issue.updated`.

During addressing, the `/to` choice remains stored for the conversation but is not the addressee of ordinary inbound messages. Include a matching `@`-mention to address another agent.

## `/who` — who replies now

Names the current addressee with its aliases and how it was chosen: `chosen with /to` or `the chat's default agent`. When the chosen agent is no longer available (for example terminated), the reply says the addressee is unavailable and suggests `/to <alias>`.

## Protection

- The commands run only inside the sender's own bridged conversation: the sender must be a board user with a linked Telegram account (the same identity-link gate that guards every bridged-DM command). A sender without a linked account gets the bridge's refusal, not a command reply.
- Only agents of the sender's own company are ever listed or addressable — the company scope is part of every lookup.
- Group topics are unchanged by this feature: these commands are DM-only. The
  topic mention rules now depend on the topic-inbound gate — see
  [telegram-topic-inbound.md](telegram-topic-inbound.md): with the gate off or
  with `requireMention` on, a topic message still has to address the bot.

## Related

- [telegram-dm-status.md](telegram-dm-status.md) — the bridged DM itself: what the standing conversation is and how to enable it (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
- [telegram-bridge-locale.md](telegram-bridge-locale.md) — the language of the bot's replies and command menu (the new commands' texts come from the same catalogs).
- [telegram-topic-inbound.md](telegram-topic-inbound.md) — messages of Telegram forum topics becoming tasks (TG-NOTIFY part D); off by default.
