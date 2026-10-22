# Stand scenario: kill the gateway mid-run

> Русская версия: [team-liveness-stand-scenario.ru.md](team-liveness-stand-scenario.ru.md)

The check that lets the operator watchdog `team-watch.sh` be switched off: the
board brings the team back by itself after the gateway dies mid-run. No human
takes any action in the scenario — they kill the gateway and read the verdict.

Runner: `scripts/myrmidon/team-liveness/stand-recovery.ts`. It carries no
opinion of its own about liveness: every decision is taken by the **product
passes** (RUN-STALL by progress, AUTO-RESUME, IDLE-PICKUP), built exactly as
`server/src/index.ts` and `src/services/heartbeat.ts` build them. The runner only
seeds the situation, kills the process, moves the clock and reads the database
back.

## What the verdict is made of

Three legs, all of which must arrive:

1. **the run is settled** — the abandoned run is not left in `running`;
2. **the task is not left waiting** — it left `in_progress`, and it has either a
   wake (`agent_wakeup_requests` with this task's `payload.issueId`) or a new
   live run;
3. **the agent is not stuck** — not in `error`, or the activity log has an
   `agent.auto_resume_issued` row (the board lifted it by itself).

Plus the budget: from the moment the gateway was killed to the last leg that
arrived — no more than `--budget-min` (10 minutes by default). The verdict is
`PASS`/`FAIL` in the output and in the exit code (0 passed, 1 did not).

## Two modes

```sh
# Self-contained rehearsal: throwaway embedded database, a real gateway process
# (SIGKILLed), the clock stepped in 5-second ticks.
tsx scripts/myrmidon/team-liveness/stand-recovery.ts rehearse --stall-sec 120

# The live run on the stand: read-only. The operator has already killed the gateway.
tsx scripts/myrmidon/team-liveness/stand-recovery.ts watch --since 2026-10-05T18:00:00Z
```

`rehearse` writes the knobs through the same API the panel uses
(Instance → General → Team liveness), so it also shows a saved value taking
effect without a restart. `--then-watch` prints the `watch` verdict over the same
database right after the rehearsal (which exercises the second mode's queries),
`--db <url>` rehearses against a database the caller already has, `--json` prints
the verdict machine-readably, and `--budget-min` moves the budget.

## The knobs that fit the scenario into 10 minutes

The default stall threshold is 20 minutes — **more than the budget**: a silent run
is only noticed on its 20th minute. The rehearsal therefore sets the threshold
below the budget (`--stall-sec 120`, the contract minimum is 60 s) and the pickup
interval to 5 s. On the stand, set the same values on Instance → General → Team
liveness; no restart is needed.

If the kill takes the run terminal immediately (process death, adapter refusal),
the stall threshold is not involved at all: the board sees the process loss on its
own, and then AUTO-RESUME (1/5/15 min backoff) and IDLE-PICKUP (interval and wake
budget) do the work. The threshold is for the "process alive, no progress" case.

## Running it on the stand

1. Make sure all three behaviours are on (Instance → General → Team liveness:
   `autoResumeEnabled`, `runStallEnabled`, `idlePickupEnabled`).
2. Take an agent with a live run and kill the run's process on the board host
   (`kill -9 <pid>`; the pid is in `heartbeat_runs.process_pid`). That is the
   "kill the gateway mid-run" — from the board's side the process is gone.
3. Note the kill time and run `watch --since <that time> [--agent <name>]`.
4. `PASS` — the board brought the team back by itself, inside the budget. Only
   then switch `team-watch.sh` off. `FAIL` — see which leg never arrived.

## If it fails

- **the run is not settled** — progress-based liveness did not fire: check the
  stall threshold and that the run's progress marks (`last_output_at`, run
  events) really stopped moving;
- **the task is left waiting** — the task stayed `in_progress` with no wake: read
  the activity log (`myrmidon.run_stall.interrupted`,
  `issue.idle_pickup_wake_emitted`) and the wake requests; a wake may have been
  refused admission (limits, pause, maintenance window) — then it stays `queued`
  and starts with the ordinary queue sweep;
- **the agent is in `error`** — auto-resume is either off or out of attempts
  (then the attention desk carries an `agent_error_alert` card saying the board
  gave up).

## How it relates to acceptance

The ticket's acceptance is 24 hours of production observation with
`team-watch.sh` switched off: no agent in `error` for more than 20 minutes and
none idle with a ready task for more than 10 minutes. That is read from the
"Team liveness" card on the company page (auto-resumes / resumes given up / wakes
/ stalled runs over 24 h) — the daily equivalent of this scenario.