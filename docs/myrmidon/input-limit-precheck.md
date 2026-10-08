# Model input limit checked before a run is sent (OPE-6168)

> Русская версия: [input-limit-precheck.ru.md](input-limit-precheck.ru.md)

The [input-overflow guard](input-overflow-guard.md) reacts after the provider
rejected a request. This check acts before: the board knows every model's input
limit and does not send a run that would not fit.

## Where the limit comes from

The model catalog: `litellm_models.maxInputTokens`, the table the gateway
model sweep fills and the prompt-budget report already reads. The model is the
agent card's `model`. An explicit override beats the catalog: adapter config
`inputLimitTokens` and/or `inputLimitChars`. A model the catalog does not know
and without an override has no limit, and nothing is invented for it.

Tokens and characters are converted with a conservative ratio (3 characters per
token), and a request may use 90 % of the limit (the rest absorbs the estimate's
error). Both are tunable: `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` and
`MYRMIDON_INPUT_LIMIT_SAFETY`. `MYRMIDON_INPUT_LIMIT_PRECHECK=0` turns the whole
check off.

## What happens before dispatch

1. **Fresh session when the session is full.** The board adds up the prompts it
   has sent into the task's current session (the stored prompt breakdowns of the
   agent's runs on the issue, failed runs included, counted from the latest
   reset or provider overflow). If that sum plus a prompt like the last one
   exceeds the budget, the run starts a fresh session (the saved session is not
   resumed and the `hermes_gateway` session key moves to the next generation
   `:g<N>`) and a warning lifecycle event
   (`payload.inputLimit.action = "fresh_session"`) is recorded. That event is what
   keeps later runs on the new generation: generation = (PERF-DIET-K session generation) + overflow failures +
   recorded resets.
2. **Trim when one request alone is too large.** The limit travels to the
   adapter as `config.inputLimit`. If instructions + input exceed the budget, the
   `hermes_gateway` adapter cuts the input (the head, which holds the identity
   and contract, and the tail, which holds the newest wake context, are kept; the
   middle becomes a marker that states how many characters were omitted) and logs
   the cut in the run log. The instructions are never cut and the input never
   drops below 4 000 characters.

The estimate counts what the board sent; Hermes compacts a session on its own,
so the board may start a fresh session earlier than strictly needed. That is the
safe direction. The Hermes side of the same incident (a failed turn leaving its
prompt in the session) is bot-runtime patch `11-stranded-run-turn-replace.patch`.

## Code

- `packages/adapter-utils/src/input-limit.ts` — hint, budget, decision, trimming.
- `server/src/myrmidon/input-limit/input-limit.ts` — catalog lookup, session
  estimate, reset decision; hooked into `services/heartbeat.ts` next to the
  overflow guard.
- `packages/adapters/hermes/src/gateway/server/execute.ts` — the trim.
