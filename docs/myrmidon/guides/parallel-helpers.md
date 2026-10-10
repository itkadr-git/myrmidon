# Parallel helpers

> Russian version: [parallel-helpers.ru.md](parallel-helpers.ru.md)

An agent can split a task across parallel helper subagents
(`delegate_task`): one helper per independent part, running at the same time
instead of one after another. Whether an agent may do this, how many helpers
it may run at once and which model the helpers use is decided on the board —
by the agent's card and one instance-level settings section. This page covers
both, plus what the compiled bot profile does with them.

## The agent card: "Parallel helpers" section

On the card of an agent with the `hermes_gateway` adapter (not while the
agent is being created) there is a collapsible **Parallel helpers** section:

| Field | What it sets |
|---|---|
| **Allow parallel helper subagents** | The master switch. On — the agent may call `delegate_task` and run helper children. Off — the `delegation` toolset is removed from the agent's compiled toolset, so the tool does not exist for it. A card that never touched the section behaves exactly as before the feature. |
| **Max concurrent helpers** | How many helpers may run at once. Accepted whole numbers: 1 or greater — there is no built-in upper bound (HELPERS-NO-CAP); the value is clamped server-side to the company ceiling when the bot profile compiles. Turning the switch on with no limit writes the company default (or `2` when the instance has none). |
| **Helper model** | The model the helper children run on, picked from the same model list as the agent's main model. A `provider/model` id pins the child's provider; a bare model name leaves the provider empty and the child inherits the parent's provider and credentials. Empty — the helpers run on the parent agent's model (the instance-level fallback chain is below). |
| **Per-helper turn budget** | The turn cap per helper subagent (`delegation.max_iterations`), accepted whole numbers 1–500. Empty keeps Hermes' own default (250). |

The block is stored on the card as `adapterConfig.parallelHelpers`
(`enabled`, `maxConcurrent`, `model`, `childTurnBudget`), so it rides the
existing agent-edit permission and change log — no separate access rule.
Turning the switch off keeps the stored limit, model and budget: switching it
back on restores them.

Every change reaches the running bot on its **next reconcile tick**, without
a restart: the profile compiler re-reads the card on every pass and rewrites
the container's `config.yaml`. Use the card's **Apply now** button
([bot-container-card](bot-container-card.md)) when the change should apply
immediately.

## The instance settings: ceiling, default, capacity

**Instance → General → "Parallel helpers"** sets the company-wide frame the
cards live in. Saving writes `instance_settings.general.parallelHelpers`;
the compiler re-reads the row on every reconcile tick, so a change reaches
every bot's `config.yaml` within one tick, without a restart. The panel reads
through `GET /api/myrmidon/parallel-helpers` (any board member) and writes
through `PATCH /api/myrmidon/parallel-helpers` (instance admin only). Every
save is recorded in the activity log as `instance.parallel_helpers.updated`
with the previous and next values.

| Field | What it bounds | Default |
|---|---|---|
| **Helpers per agent (ceiling)** | The highest value any agent card may set; cards above it are clamped at compile time. The ceiling itself has no built-in upper bound (HELPERS-NO-CAP): the saved number is the limit, and a saved ceiling above 50 only shows a host-load warning on the settings page — it is never clamped or rejected. | `10` |
| **Default helpers per agent** | What an agent gets when its card names no limit. New agents inherit it. Never resolved above the ceiling. | `2` |
| **Shared build slots** | Concurrent build slots on the shared dev host — an input to the capacity hint only, it never clamps a card. Empty = unknown. | unset |
| **Dev host memory, MB** | Memory of the host running the bots — also only an input to the capacity hint. Empty = unknown. | unset |

Leave a field empty to keep the built-in default. The panel shows the values
in force («In force: ceiling …, default … per agent»).

The **capacity hint** sums the resolved per-agent limits over every agent
with helpers switched on (across all companies of the instance) and compares
the total with the shared build slots:

- total above the slots — an amber warning: builds queue, runs are not
  blocked;
- slots unset — a note that the total is not checked against the host;
- otherwise a quiet line with the total and the number of enabled agents.

The hint is a warning, never a block: helpers are cheap when idle and
expensive when they all work at once, so the arithmetic is shown and the
decision stays with the operator.

## What the bot's profile gets

When the card has helpers on, the profile compiler writes a `delegation`
section into the bot's `config.yaml`:

- `max_concurrent_children` — the card's limit after clamping to the company
  ceiling;
- `model` / `provider` — the helper model, split on the first slash;
- `max_iterations` — the per-helper turn budget, written only when the card
  sets one.

When the card has helpers off, the compiler adds `delegation` to
`agent.disabled_toolsets` instead — the switch subtracts the toolset last, so
no toolset combination can re-enable `delegate_task` for that agent. A card
that never mentions helpers compiles to exactly its previous `config.yaml`.

When neither the card nor the stored settings name a model, the compiler
falls back to the `MYRMIDON_BOT_HELPER_MODEL` environment variable read from
the agent card's environment; when that is unset too, the helper children run
on the parent agent's model (Hermes' own behavior for an unset
`delegation.model`). See [SETTINGS.md](../SETTINGS.md).

## The bundled skill

Agents get the matching operating rules from the bundled skill
`parallel-helpers` (category software-development, recommended for the
engineer role): when a task should be split across helpers and when it must
stay in one context, the anti-collision rules (never two helpers on the same
file; git operations stay with the task owner), and where the limits come
from. It ships with the board and can be given to an agent like any other
bundled skill.
