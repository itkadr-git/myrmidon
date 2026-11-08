# Queued-run stall signal (F-09)

> Russian version: [queued-run-stall.ru.md](queued-run-stall.ru.md)

This is the operator half of the F-09 fix for queued runs that used to wait
silently for days. The other half — why a queued run waits, the
`waitReason` values, and the runs cancelled before the ceilings — lives in
[run-limits.md](run-limits.md). Do not confuse this with
[run-stall.md](run-stall.md): that guide is about *running* runs that stopped
making progress; this one is about runs that never got *started*.

## What the card means

The attention feed raises a `queue_stall` card for a run that has stayed
`queued` longer than the stall threshold **and** carries no `waitReason`.
Every exit of the queue sweep is supposed to leave a reason on the runs it
holds, so a reason-less run older than the threshold means the wait escaped
every known explanation — that is the defect the card exists to report.

Each stalled run gets its own card: the card's subject is the run itself
(`kind: "run"`), so several stalled runs never collapse into one notice.

The card offers two verbs:

- **inspect** — opens the run, so you can see the task, the agent and how long
  it has been queued;
- **dismiss** — removes the notice; the run stays queued and keeps its place.

## The attention-card threshold

The `queue_stall` attention card uses `MYRMIDON_QUEUED_RUN_STALE_AFTER_SEC`
(default `3600` seconds — one hour). The environment variable is the default;
`instance_settings.general.queuedRunStaleAfterSec` overrides it and is clamped
to 60…604800 seconds. A non-numeric, zero, negative or empty value keeps the
default. The card cannot be switched off by design; the closest is setting the
instance value to its maximum.

The companion threshold `MYRMIDON_QUEUED_RUN_EXPLAIN_AFTER_SEC` (default `60`
seconds) governs when a queued run must already carry a `waitReason` — see the
table in [run-limits.md](run-limits.md). In a healthy queue every run older
than a minute carries a reason, so the `queue_stall` card stays silent.

## Expiry and the Prometheus metric

The dispatcher separately cancels queued runs that exceed its expiry threshold.
Set `instance_settings.general.processes.queuedRunStaleAfterSec` to the number
of seconds to keep a run queued. The default is `1800` seconds (30 minutes);
the value is clamped to 60…604800 seconds. The dispatcher re-reads it each
sweep. `general.processes.queuedResweepSec` controls the sweep interval (default
`30` seconds). This expiry setting is distinct from the attention-card setting
above.

On successful expiry, Myrmidon records the cancellation reason in the run's
error and activity log. If the run has issue context, the sweep releases the
issue execution lock. It then wakes the agent so other ready work can proceed.

The root `GET /metrics` endpoint exports
`myrmidon_runs_queued_over_30m{role="…"}` as a gauge. It counts only rows whose
status is `queued` and whose creation time is more than 30 minutes ago. The
30-minute metric threshold is fixed; changing the expiry threshold does not
change it. For example, configure the external Prometheus-compatible alerting
stack to alert when `myrmidon_runs_queued_over_30m > 0` remains true for five
minutes. This repository exposes the metric; it does not install that alert
rule. Confirm the metric reaches zero after deployment and test recovery with
a controlled stale run before considering operational acceptance complete.

## What to do about it

A `queue_stall` card that appears once and goes away after the next sweep
means a pass briefly left a run unexplained — nothing to do. A card that stays
for hours, or several cards at once, means runs are waiting for a reason the
sweep does not know: open the run with **inspect**, check the agent (paused,
maintenance window, retired) and the task (hidden, in `backlog` — those are
handled separately, see the cancel rule in
[run-limits.md](run-limits.md)). If neither explains the wait, that is a bug
worth reporting: the whole point of F-09 is that a queued run never waits
without a name for its wait.
