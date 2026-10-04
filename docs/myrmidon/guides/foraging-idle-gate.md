# Foraging: only when the role is idle (1.6.2 FORAGING-IDLE-GATE)

> Russian version: [foraging-idle-gate.ru.md](foraging-idle-gate.ru.md)

The rule: learning happens in the idle time of a role, work always comes first.
With the idle-only switch on, a pass reads only the sources of roles whose
agents have no work in flight; a role with a queued or running run is held back
and the pass says why.

Module: `server/src/myrmidon/foraging/` (same path as 1.6 FORAGING); screen:
`/foraging`, the "Only when idle" card above the source registry.

## The switch

The switch is per company and lives in the interface — `instance_settings.general.foragingIdleGate`
(`{ companies: { <companyId>: { idleOnly, updatedAt } } }`). The board flips it
on the screen (`PUT /api/myrmidon/companies/:id/foraging/idle-gate`), the sweep
re-reads the stored value on every pass, so the change lands in the NEXT pass
and no restart is needed.

Precedence, and the screen always shows which of the three answered:

| Source of the value | When it answers | Label on the screen |
| --- | --- | --- |
| `env` | `MYRMIDON_FORAGING_IDLE_ONLY` is set — an operator force for the whole instance | "the environment" |
| `interface` | the company has a stored row | "the interface" |
| `default` | nobody answered — the rule is off | "the default" |

`MYRMIDON_FORAGING_IDLE_ONLY` accepts `1/true/yes/on` (force on) and
`0/false/no/off` (force off); anything else is "not set", so a typo cannot
silently flip the rule.

## What a pass does

1. Read the enabled sources of the company.
2. With the rule off — read them all, exactly as before.
3. With the rule on — ask which of the source roles have an agent with a
   `queued` or `running` run (`foraging_busy_run` statuses), and read only the
   idle roles.
4. If EVERY role has work, the pass does nothing this tick and is recorded with
   the reason `agents_busy_for_role` and the roles it held back. A partial pass
   still runs and still records the roles it skipped.
5. A probe that fails never fails the pass: the gate opens and the pass runs as
   it did before the feature.

## History

Every pass is appended to `instance_settings.general.foragingPassJournal`
(newest first, capped at 20 per company) and shown on the screen as "Pass
history": when, the outcome (`Ran`, or the localized reason), the roles that
were held back, how many sources were read and how many findings appeared.
`GET /api/myrmidon/companies/:id/foraging/passes?limit=` returns the same rows.
The journal is best effort: a history that cannot be written never fails a pass.

## Tests

- `server/src/myrmidon/foraging/agent-idle-check.myrmidon.test.ts` — the plan
  (which roles a pass may read, when the whole pass is held back), the
  environment force, and the pass itself: the reason is recorded, the rule is
  re-read on every pass, a failing probe opens the gate.
- `server/src/myrmidon/foraging/routes.myrmidon.test.ts` — the switch and its
  source, the write (board only), the pass history.
- `packages/shared/src/myrmidon-foraging-idle-gate.myrmidon.test.ts` —
  precedence, the stored shape, the journal cap.
- `ui/src/pages/Foraging.test.tsx` — the rule with the source of its value, the
  switch flipping, the reason of a skipped pass.