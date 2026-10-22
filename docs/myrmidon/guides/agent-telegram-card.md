# Telegram fields on the agent card

> Russian version: [agent-telegram-card.ru.md](agent-telegram-card.ru.md)

The agent card carries a **Telegram** section (below the nests block) where a
board operator sees and edits exactly what the Telegram bridge uses to address
this agent and where `/agents` files its card. Before it existed, these two
values could only be set by hand through the API.

Both values live in the agent card's `metadata` JSON:

- `telegramAliases` — a list of strings, the aliases the bridge answers to;
- `telegramGroup` — a free-text group title the `/agents` list groups the card
  under.

Saving uses the existing `PATCH /api/agents/{agentId}` with a `metadata` body:
the section re-reads the agent first and changes only the two Telegram keys,
so every other metadata key survives the save.

## Aliases

- The alias rows are editable: type into the input and press **Add** (or
  Enter); remove a row with the ✕ next to it.
- An alias is **lowercase latin letters, digits and underscores** — the same
  alphabet the bridge resolves (`adm-dev-eng-15` → `15`). A draft with other
  characters, or a duplicate of a row already in the list, is blocked with an
  inline error and never saved.
- Matching in the bridge is case-insensitive and the same alias works with or
  without the `@` in `/to` and `@`-mentions; see
  [telegram-multi-agent.md](telegram-multi-agent.md).

### The default alias

While the alias list is empty, the section names the **default alias the
bridge computes from the agent name**: the last dash-separated segment of the
name, lower-cased, latin letters/digits/underscores only (`adm-dev-eng-15` →
`15`, `Wiki Maintainer` → `wikimaintainer`). A tail with no latin character at
all yields no default — the card then says so and suggests adding an alias.

This is a read-time convenience: nothing is written back to the card, an
explicit alias always wins, and the computed aliases never shadow another
agent's name or an alias set explicitly (a collision gets a `-2`, `-3`, …
suffix, company-wide, in name order).

## Group

The **Telegram group** row holds the group title the `/agents` list shows
this card under (`metadata.telegramGroup`). The input suggests the company's
existing group titles through a datalist, so agents land in the same group
without retyping it. An empty value groups the card by its name prefix (the
bridge's built-in `adm*`/`bbq*`/`work*`/other groups).

## What the save does

- Immediate, per change — the bridge reads the card fresh on its next pass,
  so no restart or redeploy is needed.
- The metadata patch starts from a fresh GET of the agent and touches only
  `telegramAliases` and `telegramGroup`; clearing all alias rows deletes the
  key (the bridge computes the default again), and a blank group deletes
  that key.

## Related

- [telegram-multi-agent.md](telegram-multi-agent.md) — how the bridge uses
  the aliases: `@`-mentions, `/agents`, `/to`, `/who`, precedence rules.
- [telegram-dm-status.md](telegram-dm-status.md) — the bridged Telegram DM
  itself (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
