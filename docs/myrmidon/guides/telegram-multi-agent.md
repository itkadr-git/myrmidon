# Addressing agents from one Telegram chat

> Russian version: [telegram-multi-agent.ru.md](telegram-multi-agent.ru.md)

One bridged Telegram DM (guide [telegram-dm-status.md](telegram-dm-status.md), setting `MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) can address any agent of the company, not only the agent assigned to that endpoint. There are two ways to pick the addressee:

- **A `@`-mention in the message text** routes that one message to the mentioned agent; the reply comes back in the same chat with the agent's display name in brackets, like `[Hypotheses] …`.
- **The `/to` command** sets a sticky default addressee for the chat, so the following messages go to the chosen agent without a mention.

Mentions and commands work in the same chat and combine freely: a `/to` choice holds until you change it, and a `@`-mention addresses its agent for that message.

## Aliases

An alias is a short handle for an agent, stored in the agent card as `telegramAliases` — a list of strings in the card JSON (`metadata` first, then `adapter_config`; both are only read). Matching is case-insensitive; the same alias works with or without the `@` in `/to`.

When two agents could match, an alias beats a name, and a name beats a title.

Setting or changing aliases is a card edit by an administrator; there is no chat command for it.

## `/agents` — who can be addressed

Lists the company's agents that this chat may address: display name and aliases, one agent per line, the current addressee marked `current addressee`. Agents in `terminated` or `pending_approval` status are never listed and cannot be addressed. The list holds at most 60 agents.

If the company has no addressable agents, the reply says so.

## `/to` — choose the default addressee

- `/to <alias>` — the chat now addresses that agent by default, until the next `/to`. The reply confirms the chosen agent and its aliases. Choosing the agent that is already the default answers that the addressee is already set.
- `/to` without an argument — clears the choice; the chat's assigned agent replies from then on. If no choice was set, the reply names the agent that replies by default.
- An unknown alias answers with the list of available aliases (or, when no aliases are set at all, points to `/agents`).

The choice is stored in the conversation issue's `assignee_adapter_overrides` JSON column under the key `telegramStickyAgentId` — the same column `/model` and `/think` use, merged with their values; the `adapterConfig` key is untouched, so choosing an addressee never resets the chat's model session. Each change is recorded in the activity log as `issue.updated`.

In this release the stored choice is reported by `/who` and `/agents` and kept for the conversation; routing of unmentioned messages to the sticky addressee arrives with the next part of the feature. Until then, address another agent with a `@`-mention.

## `/who` — who replies now

Names the current addressee with its aliases and how it was chosen: `chosen with /to` or `the chat's default agent`. When the chosen agent is no longer available (for example terminated), the reply says the addressee is unavailable and suggests `/to <alias>`.

## Protection

- The commands run only inside the sender's own bridged conversation: the sender must be a board user with a linked Telegram account (the same identity-link gate that guards every bridged-DM command). A sender without a linked account gets the bridge's refusal, not a command reply.
- Only agents of the sender's own company are ever listed or addressable — the company scope is part of every lookup.
- Group topics are unchanged: they keep the previous mention rules, and these commands are DM-only.

## Related

- [telegram-dm-status.md](telegram-dm-status.md) — the bridged DM itself: what the standing conversation is and how to enable it (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
- [telegram-bridge-locale.md](telegram-bridge-locale.md) — the language of the bot's replies and command menu (the new commands' texts come from the same catalogs).
