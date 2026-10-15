# Spend limits per hierarchy level (1.7 BUDGET-CONFIG)

Myrmidon stores spend limits per level of the hierarchy and exposes them
through an API with a full change journal. A limit answers one question: "how
much may this scope spend per period, and what happens at the limit". The
module is `server/src/myrmidon/budget-limits/` (track 1.7 BUDGET-CONFIG,
part A).

## Levels

One row per `(company, level, ref)`:

| Level | `ref` | What it limits |
|---|---|---|
| `nest` | `company`, or a project uuid | the whole company, or one project |
| `caste` | a role key (`engineer`, `designer`, …) | every agent of that caste |
| `foraging` | `foraging` | the FORAGING sweep's own pass budget (absorbs OPE-3964) |
| `issue` | an issue uuid | one task |

Each row: `amountCents`, `period` (`calendar_month_utc` or `lifetime`), `mode`:

- `hard` — refuse: work over the limit is rejected;
- `soft` — pause and a card to the owner: "extend by $N or stop".

## The global "signal only" mode

The global mode `signalOnly` is ON by default and stays on until the owner
turns it off explicitly. While it is on, limits never stop work — every
over-limit state is a signal, not an enforcement. The mode is runtime-mutable
(no restart):

```
GET   /api/myrmidon/companies/:companyId/budget-limits/signal-only
PATCH /api/myrmidon/companies/:companyId/budget-limits/signal-only   (board)
      body: { "signalOnly": false }
```

The GET answers the effective value **and its source** — `stored` (what the
owner set), `default` (nothing stored yet; ON), or `env` (the forced
override `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` is set, and it wins over the
stored value). A typo in the env value never flips the owner's choice: only
`1/true/yes/on` and `0/false/no/off` are accepted, everything else is ignored.

## The API

Base: `/api/myrmidon/companies/:companyId/budget-limits`. Reads need company
access; every mutation needs a board actor and writes an activity-log row.

```
GET    .../budget-limits                  list (optionally ?level=)
GET    .../budget-limits/limits/:level/:ref       one limit
PUT    .../budget-limits/limits/:level/:ref       create or replace (board)
       body: { amountCents, period, mode, isActive }
DELETE .../budget-limits/limits/:level/:ref       remove (board)
GET    .../budget-limits/journal          change journal, newest first
GET    .../budget-limits/usage            per-limit spent + overLimit
GET    .../budget-limits/signal-only      effective flag + source
PATCH  .../budget-limits/signal-only      turn enforcement on/off (board)
```

`PUT` is idempotent per `(company, level, ref)`: saving the same triple
replaces the row.

## The change journal

Every create, update and delete writes a `budget_limit_changes` row: who
(`actorType`/`actorId`), when (`at`), and what (`before`/`after` snapshots of
the changed fields). The journal is append-only; deleting a limit keeps its
history. `GET …/journal` returns it newest-first, optionally per level.

## "Spent in period"

`GET …/usage` computes each limit's spend from the existing accounting — the
`litellm_cost_events` ledger the M2-A sweep collects (attributed per agent,
per issue, with `occurredAt`):

- nest `company` → all events of the company in the window;
- nest project → events whose issue belongs to the project;
- caste → events of the agents whose role is the ref;
- issue → events whose `issueId` is the ref;
- foraging → the FORAGING sweep's own budget state.

The window is the limit's `period`: `calendar_month_utc` is
[first day of the current UTC month, first day of the next), `lifetime` is
unbounded — the same math the vendor budget policies use.

## Tables

Migration `0312` adds two tables, both additive (no vendor table is touched):

- `budget_limits` — the limit rows, one per `(company_id, level, ref)`;
- `budget_limit_changes` — the journal.

The signal-only flag does not need a table: it lives in
`instance_settings.general.budgetLimits` (the same JSON-column pattern the
WIP limit and STT runtime settings use).
