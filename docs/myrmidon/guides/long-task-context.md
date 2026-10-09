# The long-task context guard (1.6.6 LONG-TASK-CONTEXT)

> Русская версия: [long-task-context.ru.md](long-task-context.ru.md).

A task that has no end date — a porting ticket, a long-running review, a task
whose thread just keeps growing — used to kill its own runs. On 09.10.2026 two
tasks did it in one evening:

- OPE-3931 (165 comments, ~120k characters): the runs at 19:51 and 21:25 died
  with `Context compression timed out: approximately 214 298 / 378 739 tokens`;
- OPE-6298 at 19:04: `Context compression timed out without reducing this
  conversation`.

In both cases the agent's status became `error` and the task did not move again
until a human reset the task session by hand. Resetting the session helped for
one or two runs and the task bloated again.

The guard has three parts, and they cover different moments of the story.

## 1. A compression timeout is a recoverable failure

The runtime prints those two messages when its own context compaction gives up.
They did not match the context-window signatures, so the run went down the
generic failure path and left the agent in `error`. Now both shapes are part of
`CONTEXT_WINDOW_ERROR_SIGNATURES` (`server/src/services/heartbeat.ts`): such a
run drops the task session and leaves the agent idle, i.e. walks the path that
was already in place for a context-window error, so the next wake of the task
starts from a fresh session instead of a stuck agent.

## 2. Compression up to the threshold, not after it

Waiting for the timeout means paying for it: the run is lost, and the runtime
has already spent time compacting a session it cannot compact.

Before a run resumes a task session, the guard measures how much of the model
window the task's own last prompt took (the newest run of this agent on this
issue that carries a prompt breakdown, and the model window of the agent's
configured model; the fallback window applies when the model has no known
`maxInputTokens`). At or above `resetPct` of the window the session is dropped
before it is resumed, and the reason is written into the run's own context:

The run-log reason and the launch context then read:

```
long-task context guard: the last run's prompt took 71.3% of the 378739-token
window (threshold 70%), so the task session is reset and the run starts from the
continuation summary
```

```
Long-task context guard: this run starts a FRESH task session. The previous
session's last prompt was 270000 tokens (71.3% of the 378739-token window,
threshold 70%), so it was dropped before the window was reached — resuming it
would have ended in "Context compression timed out". The continuation summary
below carries the work done so far; older entries of the thread stay readable
through GET /api/issues/<issueId>/comments (oldest first).
```

The context of the task is not lost: the continuation summary the board already
builds for the task rides along with the wake payload, and the task thread stays
readable in full through the issue API.

## 3. The payload stops growing with the thread

`MYRMIDON_CONTINUATION_HISTORY_LIMIT` (30 newest entries per list) bounded the
*count* of history entries, but not its volume: thirty comments of 4k characters
each are 120k characters in every run, and one huge comment travelled whole. The
limit is now two-dimensional (`server/src/myrmidon/continuation-history-limit.ts`):

- `MYRMIDON_CONTINUATION_HISTORY_CHARS` (default `24000`) — the total budget of
  message text in the payload. The newest entries that fit the budget travel;
- `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` (default `8000`) — the cap of a
  single entry: its tail is replaced by a marker naming where the full text
  stays.

The original request, the latest request and the comments that triggered the run
are always part of the payload (that is what "pin" means here), and the payload's
`truncationNotice` names what was omitted and points at
`GET /api/issues/:issueId/comments`. Put `0` in either variable to switch that
bound off.

## Settings

The guard's settings live with the other live instance settings, in
`instance_settings.general.longTaskContext`:

| Field | Default | What it does |
|---|---|---|
| `enabled` | `true` | `false` = the pressure is measured and reported, but no session is dropped early |
| `resetPct` | `70` | The share of the model window at which the session is dropped before the next run resumes it |
| `fallbackWindowTokens` | `200000` | The window the percentage counts against when the agent's model has no known `maxInputTokens` |
| `historyChars` | `24000` | The `historyChars` value the operator set (the runtime bound is read from `MYRMIDON_CONTINUATION_HISTORY_CHARS`) |

An absent or malformed row falls back to the full default set — a hand-edited row
never half-applies. Each field can be overridden by the environment
(`MYRMIDON_LONG_TASK_CONTEXT_*`, see
[SETTINGS.md](../SETTINGS.md), Track 2) and every effective value is
attributable: the resolution reports whether it came from the environment, from
the stored row, or from the defaults. The panel and the API route for this
settings area are not part of this part.

## How to tell it worked

- The acceptance criterion is the run log: **0 runs per day with
  `Context compression timed out`**. A run that trips the guard instead carries
  the reset line in its own context (`Skipping saved session resume for task …
  because long-task context guard: …`), so the fix is visible in the same place
  the failure used to be.
- A task that keeps hitting the threshold run after run means its single prompts
  are large on their own: look at the prompt breakdown of the run and lower
  `MYRMIDON_CONTINUATION_HISTORY_CHARS`, or move the long history into the task
  document instead of the thread.
- To switch the guard off entirely: `MYRMIDON_LONG_TASK_CONTEXT_ENABLED=0`
  (session resets stop, the signature recognition of part 1 stays — it restores
  a vendor behaviour fix and is not switchable by design).