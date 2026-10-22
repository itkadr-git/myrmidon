# LiteLLM budget projection (BUDGET-CONFIG C)

> Russian version: [litellm-budget-projection.ru.md](litellm-budget-projection.ru.md)

The board owns the spend limits; the LLM gateway (LiteLLM) enforces them.
This feature projects every limit saved on the board into the gateway's own
budgets — per-key budgets via `/key/update` and tag budgets via
`/budget/update` — without restarting anything, within a minute of the
change. One point of change: the limit is edited on the board (the settings
API or the UI screen of part D), never in two places.

## Where the limits live

Per company, under `instance_settings.general.myrmidonBudgetProjectionCompanies[companyId]`
(the same no-migration JSON pattern the STT overrides use). The document:

| Field | Meaning | Default |
|---|---|---|
| `enabled` | Master switch of the projection | off |
| `signalOnly` | The global "signal-only" mode: while on, every projected budget is soft — limits never stop work until the owner turns it off | on |
| `limits` | The limit rows: `{ level, scopeId, amountUsd, periodHours, mode }` | empty |
| `sweepIntervalSec` | The company's sweep interval, seconds | null (30 s) |

Levels are the epic's hierarchy: `nest` (company/project) → `caste` →
`foraging` → `ticket`. `mode` is the row's own choice: `block` (the gateway
refuses calls past the limit) or `soft` (the board signals and cards the
owner). The global `signalOnly` switch overrides every row to soft while it
is on — the epic default.

## The API

```
GET   /api/myrmidon/companies/:companyId/litellm-budget-sync/settings
PUT   /api/myrmidon/companies/:companyId/litellm-budget-sync/settings   (board only)
GET   /api/myrmidon/companies/:companyId/litellm-budget-sync/status
POST  /api/myrmidon/companies/:companyId/litellm-budget-sync/re-sync    (board only)
```

Reads need company access; writes need a board actor. The settings GET
answers the effective document plus `sweepIntervalSec` and
`sweepIntervalSource` — `"settings"`, `"env"` or `"default"` — so the
interface can show where each value came from (the SETTINGS-TO-UI contract).
`MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC` is a **forced** override of the
interval only; unset it to give control back to the UI.

## What the projection writes

- **Tag budgets**: every limit row becomes one gateway budget on the stable
  tag `myrm-<level>-<scope>` (the gateway-side ceiling of the scope).
- **Key budgets**: every agent's gateway key (the M2-B key, addressed by its
  secret-store alias) carries the ceiling of the agent's caste —
  `agents.role` is the caste key. A caste with no limit row leaves its
  agents' keys untouched.

While `signalOnly` is on (the default) every budget is written soft: the
gateway signals, the board decides. The hard block budget is written only
when the owner turned the global switch off AND the row's mode is `block`.

## The minute guarantee

The sweep pass runs per company on an interval (default 30 s, inside the
≤ 60 s window; 10–3600 s bounds) and re-reads the stored document on every
tick, so a saved limit needs no restart. The projection targets LiteLLM's
own runtime API (`/key/update`, `/budget/update`) — the gateway applies
budgets without a restart too.

## Manual edits in the gateway are signalled, never overwritten

The sweep keeps a three-way comparison: what the **board** says, what it last
**projected** to the gateway, and what the **gateway** holds now.

- Board ≠ projected → the board changed the limit: the pass writes it and
  records the new projected state.
- Board = projected ≠ gateway → someone edited the gateway by hand: a
  **divergence**. The pass does NOT write. It posts one system-notice
  comment (tone warning) on the company's newest in-progress task, naming
  the drifted target, the board's number and the gateway's number, deduped
  per target per UTC day via the comment metadata key. The comment says how
  to resolve: re-save the limit on the board or run the re-sync.

The sanctioned way out of a divergence is the forced pass:
`POST …/litellm-budget-sync/re-sync` (board only) re-writes every target
from the board's limits and clears the divergence.

## Operator requirements

The instance must already name the gateway contour (the M2-A/M2-B settings):
`MYRMIDON_LITELLM_BASE_URL` and `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` — the
admin key is the only key that may write budgets; agent keys never manage
them. Without the contour the status and re-sync endpoints answer 503
`enabled: false`, and the sweep is a no-op.

## The change journal

Every settings save writes an `myrmidon.budget_projection.settings_saved`
row into the company activity log (who changed what, and when). Divergences
are additionally visible in the issue thread through the signal comment.
