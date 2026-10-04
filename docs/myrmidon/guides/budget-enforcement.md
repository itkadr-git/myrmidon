# Budget enforcement: signal, soft pause, or hard refusal (1.7 BUDGET-CONFIG B)

> Russian version: [budget-enforcement.ru.md](budget-enforcement.ru.md)

A budget policy that crosses its hard threshold used to have exactly one
behaviour: pause the scope, cancel the running work, and wait for the owner.
The enforcement mode turns that single behaviour into a choice — what a
crossed limit does while its incident is open:

| Mode | Default | What happens when a limit is crossed |
|---|---|---|
| `signal_only` | **yes — the default until the owner switches it off** | The incident is created and the owner is signalled (a system notice in the thread of the scope's open issues, plus the budget card in the decision inbox). The scope is NOT paused, no run is cancelled, and new runs still start: limits only signal. |
| `soft` | no | The scope is paused and the owner gets the "raise the budget or keep paused" card (Costs → Budgets, the decision inbox, and the interrupted issue threads). Raising the budget through the card lifts the pause, and held work resumes. |
| `hard` | no | New runs of the over-limit scope are refused before they start, with the budget reason (the same admission check the vendor always had, now only in this mode). Work already in flight finishes. |

The mode is one global value for the whole instance — it applies to every
budget policy of every company of this server (company, agent and project
scopes alike). Per-level configuration (which level has which limit) is the
BUDGET-CONFIG A work; this page is only about what happens after a limit is
crossed.

## Where it is set

The screen is **Instance → General → Budget enforcement** (next to the run
limits), and the API is `GET`/`PATCH /api/myrmidon/budget-enforcement`
(GET is board-readable, PATCH is instance-admin only). Saving writes
`instance_settings.general.budgetEnforcement` and takes effect at the next
budget evaluation — the very next cost event or run admission; nothing needs
a restart, and the effective value's source is shown next to the picker:

- **Saved here** — the stored settings row (an operator chose it on this page);
- **Forced by the server environment** — `MYRMIDON_BUDGET_ENFORCEMENT_MODE`
  is set and nothing was saved yet: the environment is a forced override for
  an instance that never made a choice;
- **Default** — nothing is stored and nothing is forced: `signal_only`.

Every change is audited (`instance.budget_enforcement.updated`, once per
company of the instance).

## How each mode behaves in detail

### `signal_only` — limits only signal

Both places where a hard-stop can fire (a new cost event, and saving a
policy from the settings screen) still create the hard incident, the soft
warning and the decision-inbox budget card — but they skip the pause and the
run cancellation. The interrupted threads do not exist (nothing was
interrupted), so the scope's open issues get a notice instead: "A spend
budget limit was crossed … Nothing stopped: budget enforcement is in
signal-only mode, so runs continue while the limit is over." — one comment
per (incident, issue), deduplicated, best-effort. The budget card in the
decision inbox says "Work continues: enforcement is in signal-only mode" and
carries the mode in its metadata.

The run admission gate answers nothing for an over-limit-but-not-paused
scope in this mode: a run starts exactly as it would without the limit.

### `soft` — pause and ask

The vendor pause/cancel path runs unchanged (the M3 owner signal included:
the interrupted issue threads get the "raise the budget or keep the scope
paused" report). A new run of the paused scope is refused with
"…is paused because its budget hard-stop was reached." Raising the budget
through the incident card (`raise_budget_and_resume`, the same action the
Costs screen and the decision-inbox card have) clears the pause and the
incident, and the agent becomes invokable again.

### `hard` — refuse

The scope is paused (as in soft), and additionally the over-limit check that
runs before a new run starts refuses with "…cannot start because its budget
hard-stop is still exceeded" — even when the scope is not currently paused.
This is the mode closest to the pre-1.7 vendor behaviour.

## Notes

- The two signals (this mode's notice and the M3 hard-stop report) share the
  `MYRMIDON_BUDGET_SIGNAL_MODE=off` switch: with it set, neither is delivered,
  the incidents and the stops still happen.
- Switching the mode does not reconcile already-open incidents: an incident
  opened in `signal_only` stays open when you switch to `soft` — but the next
  evaluation (the next cost event) applies the new mode, so a still-over-
  limit scope gets paused at that point. Resolve old incidents from the Costs
  screen when you switch modes with open incidents.
- `budgetService` callers that do not wire the mode hook (routes that build
  the service bare) keep the vendor semantics — always enforce; the run path
  (the heartbeat service) is the wired one.
