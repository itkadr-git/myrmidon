# MODEL-SWITCH-SESSION

## Overview

Switching an agent to a model with a smaller context window used to wedge the
agent. The saved session no longer fit the new window, every heartbeat failed
with `Context compression could not bring this session under the model's context
window` (or with an HTTP 400 `Exceeded limit on max bytes to request body` on a
very large queue task), the agent moved to the sticky error state, and an
operator had to reset the session by hand with
`runtime-state/reset-session`. A context overflow is a recoverable condition,
not an agent failure. This change makes it recoverable on its own.

## What changed

### Server — `server/src/services/heartbeat.ts`

- `isContextWindowError(message)` matches a run error message against the known
  context-overflow signatures. The match is case-insensitive and a null,
  undefined, or empty message is never a match.
- A context-window error no longer moves the agent to `error`. Both finalize
  sites pass `keepIdleOnFailure` for it (`finalizeAgentStatus` on the run path,
  and the failed-run path in the run catch), next to the existing
  `provider_quota`, workspace-sync-conflict, and transient-upstream reasons. The
  agent stays idle, so its queued work is not blocked by a health state it does
  not have.
- When a run failed with a context-window error and the run has a task key, the
  saved session for that task key is cleared (`clearTaskSessions`). The next
  heartbeat therefore starts a fresh session instead of replaying the session
  that does not fit. The clear is scoped to that task key; sessions of other
  task keys are untouched.
- The clear writes one informational `lifecycle` run-log event on the run. Its
  message names the task key, and its payload carries `reason:
  "context_window_error"` and the task key. A failed clear is logged and
  swallowed: it never fails the run.

### UI — `ui/src/components/AgentConfigForm.tsx`

The model picker cannot compare context windows. The enabled-model list the
agent card reads (`AdapterModel`) carries only `id`, `label`, and `pricing`: the
ui has no per-model context window, and the context-window size the ui does
display (the live usage readout in the task chat) comes from the running
session, not from the model catalog.

The card therefore warns about the action itself and not about a token count it
does not have: changing the model of an existing agent raises a `warn` toast
through the board's own toast channel (`useOptionalToastActions`). The toast
names the previous and the new model and states that the saved session is kept
and is cleared automatically when it does not fit. The hook is optional, so the
form still renders when it is mounted outside a `ToastProvider`.

## Error signatures recognized

- `Context compression could not bring this session under the model's context window`
- `Exceeded limit on max bytes to request body`
- `context window exceeded`
- `session too large`
- `context limit exceeded`
- `max tokens exceeded`
- `input too long`
- `prompt too long`

## Tests

`server/src/__tests__/context-window-error.test.ts` covers each signature, the
case-insensitive match, and the negatives (null, undefined, empty string, and a
message that carries none of the signatures).

## Behaviour after the change

1. A run fails with a context-window error.
2. The agent stays idle, not in error.
3. The saved session of that task key is cleared and the run log records it.
4. The next heartbeat starts a fresh session and the agent continues.

A manual reset (`POST /agents/:id/runtime-state/reset-session` with the
`taskKey`) stays available and remains the fallback when automatic clearing
itself fails, which the run log reports as a warning.

## Configuration

None. The detection and the clear need no setting.

## Limitations

- Detection is signature-based. A provider that rewords a context-overflow
  error without any of the signatures above is not recognized. The negative
  tests pin the current behaviour.
- The clear drops the in-flight session context of that task. That is the
  intended recovery: it is equivalent to the operator's manual reset.
- The warning is shown on every model change of an existing agent, because the
  ui cannot know whether the new window is smaller. It is a caution about the
  action, not a computed prediction.