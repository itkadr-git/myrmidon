# Foraging idle gate (myrmidon 1.6.3 FORAGING-IDLE-GATE)

## What it does

Product rule: **learning only when idle**. Before a foraging pass reads a
role's sources, the pass checks that the source's role is idle:

- the role's queue is empty — the same ready queue the swarm-claim idle
  wake reads (`todo` tasks of the role or unassigned, not blocked, not a
  container with open children, not mid-decomposition, not held);
- at least one agent of the role is free — not paused or in error, with no
  live heartbeat run and no live claim.

A busy role is **skipped for that pass**: its sources are not read, and the
pass result and the journal carry the reason:

| reason            | meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `queue_not_empty` | the role has ready tasks waiting in its queue          |
| `no_idle_agent`   | no agent of the role is free (paused, error, running or holding a claim) |

The gate is **per role inside one pass**: a busy engineer role never stops
the sweep from reading the smm role's sources in the same pass. The pass
never aborts because of the gate.

## The toggle

The gate is on by default. It is a settings-page value —
`instance_settings.general.foragingIdleGate` — changed through:

```
GET   /api/myrmidon/foraging/idle-gate     (board read; reports {enabled, source})
PATCH /api/myrmidon/foraging/idle-gate     (instance admin; body {enabled: boolean})
```

The pass **re-reads the toggle on every pass**, so a settings-page change
reaches the next pass without a server restart. `GET` reports the effective
value and where it came from:

- `settings` — the stored value (`general.foragingIdleGate`);
- `env` — the forced override `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` (for an
  instance that never saved the setting; `1/true/on/yes` = on,
  `0/false/off/no` = off, anything else reads as unset);
- `default` — nothing stored, nothing in the env: on.

Precedence: the stored settings value when present; otherwise the env; the
default last. An unreadable stored value counts as absent, and a settings
read failure fails open (the gate stays on) — a transient DB error cannot
wedge the foraging into skipping passes nobody asked to skip.

Other related configuration options (unchanged by this feature):

- `MYRMIDON_FORAGING_ENABLED`: Controls whether foraging is enabled overall
- `MYRMIDON_FORAGING_BUDGET_CENTS`: Sets the per-pass cost ceiling
- `MYRMIDON_FORAGING_INTERVAL_SEC`: Sets the sweep interval in seconds

## Result information

The foraging sweep result includes a `skippedReason` field when a role was
skipped due to the idle gate:

- `queue_not_empty`: that role has queued unassigned tasks
- `no_idle_agent`: that role has no free agent
- Absent: every enabled source's role was idle (or the gate is off)

## The settings screen (UI half, OPE-4149)

The "Foraging" page carries the toggle and the history:

- **Idle only** card: the switch writes the setting through
  `PATCH /api/myrmidon/foraging/idle-gate` (instance admin) and shows the
  effective value **with where that value came from** — `the interface`,
  `the environment` or `the default`. The rule is read on every pass, so a
  switch applies to the next pass; no restart. A refused write (a board
  member without instance-admin rights, a transient error) stays visible in
  the card instead of being swallowed.
- **Pass history** card: the last passes of the selected company — when each
  ran, how many sources it read, how many findings it produced, and which
  roles it left alone with the reason (`queue_not_empty` /
  `no_idle_agent`). A pass that stopped by the budget says so.

```
GET /api/myrmidon/companies/:id/foraging/passes?limit=   (company access)
```

The journal lives under `instance_settings.general.foragingPassJournal`
(newest first, capped at 50 entries for the instance; a pass of one company
never drops the history of another). Every pass appends itself — including a
pass that could not list its sources — and a failed journal write never
fails a pass. The reader is defensive: an unreadable entry loses that entry,
not the history. The journal is a view; the audit trail of a change stays in
the activity log.

## Where the code lives

- `packages/shared/src/myrmidon-foraging-idle-gate.ts` — the resolver
  contract (key, precedence, sources), shared with the server;
- `packages/shared/src/myrmidon-foraging-pass-journal.ts` — the journal
  contract (entry shape, reader, capped append), shared with the screen;
- `server/src/myrmidon/foraging/idle-gate-settings.ts` — the settings
  service (read/update/audit) and the per-pass read;
- `server/src/myrmidon/foraging/idle-gate-routes.ts` — GET/PATCH routes;
- `server/src/myrmidon/foraging/pass-journal.ts` — the journal service
  (read/record against the general row);
- `server/src/myrmidon/foraging/pass-routes.ts` — GET passes route;
- `server/src/myrmidon/foraging/service.ts` — the gate in `runPass`
  (`createDbForagingIdleCheck`: the queue + idle-agent SQL) and the pass
  recording itself in the journal;
- `ui/src/pages/Foraging.tsx`, `ui/src/api/foraging.ts` — the toggle with the
  source of the value and the pass history;
- tests: `service.myrmidon.test.ts` (the three acceptance rules, the
  per-role filtering, the re-read without recreating the service),
  `idle-gate-settings.myrmidon.test.ts` (the settings service),
  `pass-journal.myrmidon.test.ts` (the journal service, and a pass that
  records itself on every exit), `pass-routes.myrmidon.test.ts` (access, the
  limit), `packages/shared/src/myrmidon-foraging-idle-gate.test.ts` (the
  resolver), `packages/shared/src/myrmidon-foraging-pass-journal.myrmidon.test.ts`
  (the reader and the capped append),
  `ui/src/pages/Foraging.test.tsx` (the toggle, the source of the value, the
  reasons in the history).
