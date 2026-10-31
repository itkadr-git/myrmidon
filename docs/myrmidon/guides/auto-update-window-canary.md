# Board update policy: maintenance window, mode, fleet canary

1.7-AUTO-UPDATE-SETTINGS, part B. The deploy scheduler (`server/src/myrmidon/deploy-jobs`)
executes a policy instead of a single switch: **when** an update may run (the
maintenance window), **who** starts it (the operator's click, or a release tag
after a human approval) and **how much of the fleet** follows the board switch at
once (the canary). Every value is an instance setting, is read on each tick and
reports where it came from, so nothing here needs a restart.

## The policy document

One key of the settings row: `instance_settings.general.myrmidonAutoUpdate`
(`server/src/myrmidon/deploy-jobs/auto-update-store.ts`, `AUTO_UPDATE_GENERAL_KEY`).
Shape (`AutoUpdateSettings` in `auto-update.ts`):

```json
{
  "mode": "manual",
  "window": { "days": [], "fromMinute": 180, "toMinute": 300 },
  "canary": { "enabled": true, "sharePercent": 25, "minBots": 1, "maxBots": 4, "healthSettleSec": 300 },
  "approvals": []
}
```

`resolveAutoUpdateSettings(stored, env)` returns `{ settings, sources }`, where
each of `sources.mode`, `sources.window`, `sources.canary` is `ui` (the interface
wrote it), `env` (a forced override) or `default` (nothing was set). The screen
shows that label next to the value, so a configured window is never silently
replaced by a default.

The key is carried over a vendor write of `general` by
`preserveAutoUpdateGeneralKey` — the same seam R5-A/R3 use for their keys
(`server/src/services/instance-settings.ts`). A vendor write cannot drop the
update policy.

## 1. The maintenance window

`window.days` — weekdays, `0` = Sunday … `6` = Saturday, in **UTC**;
`window.fromMinute`/`toMinute` — minutes from midnight, `[from, to)`. An empty
`days` list is not "never": it means **no window**, and a deploy may start at any
time (the interface says "any time" instead of an empty table).

A deploy that was verified while the window is shut does not open the window. The
job moves to the new status **`waiting_window`**:

* the host is not touched at all — no maintenance window, no switch;
* the job carries `windowOpensAt`, the moment the current window opens (the same
  value the screen shows as "postponed until…");
* the job stays cancellable (`isAbortable` includes `waiting_window`), like any
  deploy that has not started on the host yet;
* on the first tick inside the window the scheduler resumes **the same job** and
  enters the window normally (`enterMaintenance`).

The wait is bounded by `MYRMIDON_DEPLOY_WINDOW_WAIT_TIMEOUT_SEC` (default
`604800`, a week): a job that never sees an open window aborts itself instead of
standing in the interface forever. The generic per-status timeout
(`MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC`) deliberately does not apply to this phase —
the window may be days away — and it does not apply to the canary phase either.

## 2. The update mode

`mode: "manual"` (default) — every deploy starts from the operator's click in the
interface, exactly as before part B. Nothing else can start a deploy.

`mode: "auto_release"` — a **release tag that a human approved** may start a
deploy; the scheduler starts it at the window, not on the tag. `approvals` holds
one entry per approved release; without an entry nothing is started, and the board
still never deploys the fleet without a first-class approval (autonomy matrix:
production is a human decision). An approval is not a blanket permission for
arbitrary updates: it names the release it was given for.

The `auto_release` start happens on the scheduler's tick, which runs only when no
deploy is active and only inside the window; the approval is claimed before the
job is created (the claim names the job), so a second tick or a restart cannot
start the same release twice. A deploy the scheduler started says so in the
journal (`auto_started`, with the release tag and the window state). An approval
whose deploy is still running cannot be withdrawn — abort the job; once the job is
terminal (finished, refused) the approval may be withdrawn and the release
approved again, for example with a corrected digest.

## 3. The fleet canary

The board switch itself is atomic — the board is one container — so the canary
applies to the **fleet** (the bots), which is the blast radius that matters:

* the board switches first; only its own health check closes that step;
* then `canaryPlan(targets, settings.canary)` splits the fleet: the first batch is
  `ceil(sharePercent)` of the bots, clamped to at least `minBots` and at most
  `maxBots` (a fleet smaller than the batch becomes its own batch), and `rest` is
  everyone else;
* the job enters the `fleet_canary` phase, naming the batch and what waits behind
  it; the batch is watched for at least `healthSettleSec` before its verdict is
  read, so a rollout that has not reported yet cannot pass as healthy;
* `canaryVerdict(...)` decides: a healthy batch lets `rest` follow (and the update
  closes as `succeeded`); a batch that fails ends the update as **`canary_failed`**
  and **the rest is never started** — it stays on the previous image, which is what
  the acceptance criterion of this part asks for;
* a batch that is still running keeps the phase open; the phase as a whole is
  bounded by `MYRMIDON_DEPLOY_CANARY_TIMEOUT_SEC` so a silent port cannot wedge a
  job.

Where the fleet comes from is a port (`FleetCanaryPort`: `targets`, `startCanary`,
`verdict`, `startRest`). On an instance without that port the phase is skipped with
that reason written into the journal — the instance simply has no fleet to roll
out, and the update still closes as `succeeded` rather than pretending a canary
ran.

## Statuses and the journal

| Status | Terminal | Meaning |
| --- | --- | --- |
| `waiting_window` | no | Verified, outside the maintenance window: waiting, host untouched, cancellable |
| `fleet_canary` | no | The board is switched and healthy; the canary batch is being watched |
| `canary_failed` | yes | The batch failed: the rest of the fleet stays on the previous image |

Every transition is appended to the job as a step (`appendStep`), and the update
journal in the interface is exactly that list: who started the deploy, when the
window postponed it and until when, when the canary batch went out and what its
verdict was.

## Environment (forced override only)

These exist for tests and for an operator overriding the interface, not as the
normal way to configure an update:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYRMIDON_DEPLOY_UPDATE_MODE` | — | Forces `mode` and marks its source as `env` |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS` / `_FROM` / `_TO` | — | Forces the window (days as a CSV of weekdays, hours as minutes) |
| `MYRMIDON_DEPLOY_UPDATE_CANARY`, `_CANARY_SHARE`, `_CANARY_MIN_BOTS`, `_CANARY_MAX_BOTS`, `_CANARY_SETTLE_SEC` | — | Forces the canary |
| `MYRMIDON_DEPLOY_WINDOW_WAIT_TIMEOUT_SEC` | `604800` | How long a job may wait for the window before it aborts itself |
| `MYRMIDON_DEPLOY_CANARY_TIMEOUT_SEC` | `3600` | How long the canary phase may take before the job aborts itself |

## Tests

`server/src/myrmidon/deploy-jobs/auto-update.myrmidon.test.ts` pins the policy and
the two acceptance criteria of the ticket:

* a deploy whose window is shut is postponed (`waiting_window`, no maintenance
  window entered, `windowOpensAt` names the opening) and resumes when it opens;
* a failed canary batch does not let the rest follow (`canary_failed`, `startRest`
  never called), a healthy one does, and the settle time is respected before the
  verdict is read.

`service.myrmidon.test.ts` keeps the rest of the deploy lifecycle green: an
instance whose settings row carries no policy (or a test double standing in for it)
resolves to the defaults, the same as a row that was never written.

`auto-update-routes.myrmidon.test.ts` covers the screen's API (permissions, the
reported sources, the window state, validation, approving and withdrawing) and
`ui/src/components/myrmidon/AutoUpdateSettingsPanel.myrmidon.test.tsx` the panel
itself.

## The screen and the routes

The policy is edited in the current interface, on Instance → General, in the
"Product updates" section — no 2.0 screens (they wait for OPE-3923) and no
restart: the scheduler reads the policy on every tick.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/myrmidon/auto-update` | board | the stored row, the policy in force, the source of every knob, the window right now and what the scheduler would start with the approvals it has |
| `PATCH /api/myrmidon/auto-update` | instance admin | `mode`, `window`, `canary`; one audit row per company |
| `POST /api/myrmidon/auto-update/approvals` | instance admin | approve a release (`tag`, `digest`, optional `version`); the digest must be a real `sha256:…` |
| `DELETE /api/myrmidon/auto-update/approvals/:tag` | instance admin | withdraw an approval whose deploy is not running |

Every write lands in the activity journal (`myrmidon.auto_update.*`). An agent key
is refused on every route; a board member may read the policy — the window and the
mode decide when everybody's agents pause for an update — but only an instance
admin changes it. The screen shows what the scheduler executes, including a value
the environment forces: it says so instead of pretending the edit took effect.

## Not in this part

The concrete `FleetCanaryPort` implementation over the bot rollout is the next
step; the scheduler side, the store (`readAutoUpdateDocument` /
`mutateAutoUpdateDocument`, key preservation) and the port seam are in place, so it
is additive. On an instance without a fleet port the canary phase records "no fleet
canary on this instance" and the update finishes as before.