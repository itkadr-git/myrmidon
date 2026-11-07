# Automatic resume of an agent left in `error` (AUTO-RESUME)

> Russian version: [auto-resume.ru.md](auto-resume.ru.md)

A failed run (a gateway HTTP 500, a run timeout, an adapter crash) leaves its
agent in the `error` status. The board brings such an agent back on its own:
it resumes the agent with a backoff of 1, 5 and 15 minutes and, when the
resumes keep failing, stops and escalates the agent's card on the attention
desk to "an operator must intervene". Without this feature an agent in
`error` waited until an operator resumed it by hand.

The feature ships enabled and needs no configuration. Its settings are the
`MYRMIDON_AUTO_RESUME_*` variables, listed with defaults and ranges in
[../SETTINGS.md](../SETTINGS.md). No database migration is involved: the
state lives in the agent's `metadata` under the key `myrmidon_auto_resume`.

## What the sweep does

A sweep pass runs on the scheduler tick, at most once a minute
(`MYRMIDON_AUTO_RESUME_INTERVAL_SEC`, default 60). One pass:

1. Selects every agent in `error` whose company is active.
2. Skips an agent that is not invokable (paused, terminated, or with a broken
   reporting chain) or that sits inside a maintenance window. Such an agent
   stays in `error` until it becomes invokable again.
   An agent whose last finished run is model-unavailable is resumed on its
   own long schedule instead (see "Quota and model outages" below).
3. Resumes every remaining agent whose backoff step is due: the agent goes
   back to `idle`, its `errorReason` is cleared, and the resume reuses the
   pause/resume wake chain (the same chain `POST /api/agents/:id/resume`
   triggers), so the resumed agent also wakes the work it was stranded on.
   The flip is a conditional update — only an agent still in `error` is
   claimed, so a concurrent operator resume never double-fires.

## Backoff and the attempt cap

Each errored agent carries a streak in `agents.metadata.myrmidon_auto_resume`:
the failed-resume counter, the last failure time, when the next resume is
due, and the give-up mark.

- The first automatic resume is due one backoff step (1 minute by default)
  after the agent entered `error`.
- Every next attempt waits the next step: 1, 5, then 15 minutes
  (`MYRMIDON_AUTO_RESUME_BACKOFF_MS`); the last step repeats.
- After `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` (default 3) failed resumes in
  one streak the board gives up on the agent.
- A streak whose last failure is older than
  `MYRMIDON_AUTO_RESUME_WINDOW_MS` (default 1 hour) is treated as a new
  episode: the counter restarts.

The count is of issued automatic resumes, not of their outcomes: once the
board flips the agent to `idle` and sends the wake, the attempt is spent.
If the agent lands in `error` again, the streak continues with the next
backoff step.

## Quota and model outages

A run is model-unavailable when `resultJson.model_unavailable` is set: the
model pool is out of quota or down, including a provider quota, overload or
maintenance text returned as the answer. A resume wakes every task the agent
is stranded on, and each new run fails on the same quota, so such an agent is
not resumed on the 1/5/15 minute backoff. It returns on the model-unavailable
schedule, counted from the moment its last run ended:

- 30 minutes, then 1 hour, 2 hours, 4 hours, and 6 hours; the 6 hour step
  repeats. A resume is never sooner than one step after the previous resume.
- These resumes do not count towards `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` and
  never lead to a give-up: the quota resets some day. An agent with an
  exhausted quota comes back by itself no later than 6 hours after the reset,
  with no operator action. While it waits, the sweep skips it with the reason
  `model_unavailable_wait`.
- The series counter is the `modelUnavailableResumes` field of the same state.
  Once the agent's last finished run is not model-unavailable (the model is
  back, or the error is another one) the counter is dropped and the ordinary
  backoff with its cap applies again. A series also starts over when the next
  model-unavailable run ends more than 6 hours after the last resume.
- The activity row `agent.auto_resume_issued` of such a resume carries
  `modelUnavailable: true` and the series counter in its details.

## A stopped bot container

An agent whose runs could not reach the gateway, with the retries spent, is
left in `error` with the reason "контейнер не поднят". The sweep does not
resume it onto the stopped container. It starts the bot container first,
through the board's own start path (`IdleStopService.ensureStartedAndHealthy`:
the driver's start, then a check that the container is running and healthy),
and resumes the agent only when the container is up.

- The first start is tried at once. A start that fails is retried no sooner
  than 15 minutes after the previous attempt, 4 attempts in all; each failure
  is an `agent.auto_resume_container_start_failed` row. After the fourth the
  board gives up once (`agent.auto_resume_exhausted`, the critical operator
  card below) and skips the agent until an operator acts.
- The attempt is written to the state (`containerStartFailures`,
  `lastContainerStartAt`) before the start, so a crash or an overlapping pass
  cannot repeat it. A series whose last attempt is older than 30 minutes starts
  over.
- A resume after a healthy start counts in the ordinary streak and its cap, so
  a container that starts and still refuses the gateway ends in the ordinary
  give-up. The start can take minutes, so these starts run beside the other
  agents of the pass.

## The operator card after the give-up

While the board is still retrying, the errored agent has the usual
`agent_error_alert` card on the attention desk (severity `high`). Once the
board gives up, the same card — same dedup key, one row per agent — is
escalated:

- severity becomes `critical`;
- the "why now" line reads "Automatic resume gave up after N attempt(s); an
  operator must intervene";
- the card metadata carries `autoResumeExhausted: true` and the attempt
  count.

From that point the board stops resuming the agent. The operator path is the
existing one: fix the cause of the failing runs, then resume the agent with
`POST /api/agents/:id/resume` (or the agent card in the UI). Only an
operator action re-arms the streak: a resume, an update or an error clear
written to the activity log by a user (`agent.resumed`, `agent.updated`,
`agent.error_cleared`) after the give-up. Then, if the agent
fails into `error` again later, the backoff starts over from the first step.
A change of the agent record alone (`updated_at` moved by a run or a status
change) does not re-arm it.

## Activity log and metrics

Every automatic action writes an activity log row:

| Action | When |
|---|---|
| `agent.auto_resume_issued` | The board resumed the agent (attempt number and the next due time are in the details). |
| `agent.auto_resume_exhausted` | The board reached the attempt cap and gave up (the attempts count and the error reason are in the details). |
| `agent.auto_resume_container_start_failed` | The bot container of an agent in "контейнер не поднят" did not start (attempt number, next attempt time and the error are in the details). |

The module exposes `autoResumeMetrics` / `countAutoResumesSince`, read-only
counts over the activity log (24 hours by convention) that feed the health
page. They are not wired to an HTTP endpoint yet.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_AUTO_RESUME_ENABLED` | on | Master switch. `0`/`false`/`off`/`no` disables the sweep (the vendor behavior returns: `error` until an operator resumes by hand). Unset or unrecognized — enabled |
| `MYRMIDON_AUTO_RESUME_BACKOFF_MS` | `60000,300000,900000` (1/5/15 min) | Comma-separated backoff steps in milliseconds per resume attempt; the last step repeats |
| `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` | `3` | Failed resumes in one streak before the board gives up and escalates the operator card |
| `MYRMIDON_AUTO_RESUME_INTERVAL_SEC` | `60` | Minimum spacing between two sweep passes. Below 10 — 10 |
| `MYRMIDON_AUTO_RESUME_WINDOW_MS` | `3600000` (1 h) | A streak whose last failure is older than this is treated as a new episode |

Details and the full settings table: [../SETTINGS.md](../SETTINGS.md).
