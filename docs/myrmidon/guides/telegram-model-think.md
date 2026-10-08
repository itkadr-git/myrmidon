# Choose the model and reasoning effort from a Telegram chat

> Russian version: [telegram-model-think.ru.md](telegram-model-think.ru.md)

A bridged Telegram DM (guide
[telegram-dm-status.md](telegram-dm-status.md), setting
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) carries two chooser commands that
change which model and which reasoning effort this chat's agent runs with.
The choice is per chat: it is stored in the conversation issue's
`assignee_adapter_overrides` JSON column (`adapterConfig.model` /
`adapterConfig.effort`) and overrides the agent card for this conversation
only. Each change is recorded in the activity log as `issue.updated`.

## `/model` — the model this chat runs

- `/model` without an argument shows the model in effect and where the value
  comes from (`this chat`, `agent default` or `adapter default`), then the
  numbered list of choices.
- `/model <name or number>` sets the choice: an exact model name (any case),
  a 1-based number from the list, or an unambiguous `/`-suffix of a name.
- `/model default` drops the chat override, so the agent card decides again.

`/new <model>` does the same as `/model <model>` but starts the fresh
session at once; unlike `/model`, it does not wait for a reply in progress —
the model targets the session `/new` is about to start.

The list holds at most 30 models. The card's own model and its fallbacks
come first, then the candidates below. The sentinels `default` and `auto`
(«let the adapter decide») are never listed.

### Where the list comes from (gateway agents)

For a gateway agent (`hermes_gateway`) the choices are read from the LLM
gateway in two tiers:

1. **This agent key's own allowlist** — `/v1/models` asked with the agent's
   own gateway key: the models this agent may run at all.
2. **The whole gateway catalog** the board already collects (the cost
   sweep's rows), used when the per-key read is unavailable — no key on the
   board, an unreachable gateway, or a gateway without `/v1/models`. That
   list is a superset of one agent's, so the reply adds a line saying the
   whole catalog is listed.

The list is grouped by provider family (`dashscope-*`, `zai-*`, `nous-*`),
each family under its own header line; the numbering stays continuous, so a
header never shifts the numbers you type back. For every other adapter the
list comes from the adapter's own model discovery (for example
`opencode_local` answers from `opencode models`).

## `/think` — the reasoning effort

`/think` is shaped exactly like `/model`: no argument shows the effort in
effect and its source; `<level or number>` sets it; `default` clears the
override. The fixed list of levels is `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`, `ultra`.

For the hermes adapters (`hermes_gateway`, `hermes_local`) the level is
checked against the effort policy of the model this chat would run: a GLM
model accepts only `low`, `high` and `max`. A level the model does not
accept is not written, and the reply names the allowed levels. The checked
model is the chat override first, then the agent card; with no known model
the choice is unrestricted.

## When the choice takes effect (gateway agents)

A gateway agent runs a bot container off its compiled profile, so a written
choice is applied to the profile at once, without a restart: the reply says
the change takes effect from the next reply.

- **The apply fails** — the chat's value is put back to what it was, and
  the reply names the reason and that the previous value was restored.
- **The bot-containers runtime is not wired in this process** (the feature
  is off) — the write is kept and is not an error: the reply says the new
  profile is not applied yet and the change takes effect when the profile
  is applied next.

For every non-gateway adapter the override alone is enough — the adapter
reads the value on its next run.

## Which agents accept the commands

`/model` works with `hermes_gateway`, `hermes_local`, `claude_local`,
`codex_local`, `cursor`, `cursor_cloud`, `gemini_local`, `grok_local`,
`kimi_local`, `opencode_local`, `pi_local`; `/think` works with
`hermes_gateway` and `hermes_local`. A refusal for any other adapter names
the adapter type and the reason (unsupported adapter, or no choices could
be read for the chat), in the chat user's language.

Neither command writes while a reply is in progress for this chat: the
answer is the turn-in-progress refusal, and the choice has to be repeated
after the reply.

## Related

- [telegram-dm-status.md](telegram-dm-status.md) — the bridged DM itself:
  what the standing conversation is and how to enable it
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
- [telegram-multi-agent.md](telegram-multi-agent.md) — addressing any agent
  of the company from the same DM; the chooser overrides live in the same
  conversation column as the sticky addressee and are never reset by it.
- [telegram-bridge-locale.md](telegram-bridge-locale.md) — the language of
  the bot's replies (the chooser texts come from the same catalogs).
