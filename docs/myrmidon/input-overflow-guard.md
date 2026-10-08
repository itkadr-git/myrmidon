# Input-overflow guard and fresh sessions on retry (OPE-6168)

> Русская версия: [input-overflow-guard.ru.md](input-overflow-guard.ru.md)

Incident: a `hermes_gateway` agent kept failing with the provider answer
`Range of input length should be [1, 1048576]`. Every failed turn re-sent its
~220 KB prompt into the same session, the session grew to ~9.6 MB, and the board
re-ran the issue every 3–5 minutes with the same outcome and no attention item.

## What changed

1. **Automatic transient retries start a fresh task session** (upstream
   paperclipai/paperclip #15487). `shouldResetTaskSessionForWake` now returns
   true for `transient_failure_retry`. The only exception is the codex ladder's
   explicit first `same_session` step.
2. **Input-overflow is its own error family, `input_overflow`** (not transient,
   not quota). The wording table is
   `packages/adapter-utils/src/input-overflow.ts` (DashScope "Range of input
   length should be", OpenAI `context_length_exceeded` / "maximum context
   length", Anthropic "prompt is too long", Gemini "input token count exceeds the
   maximum", generic context-window phrases). The `hermes_gateway` adapter sets
   the family; the server also detects it by text on runs of any adapter.
3. **Fresh session on the next attempt.** After such a failure the server drops
   the saved task session and passes `context.sessionGeneration` (the number of
   overflow failures on the issue). `hermes_gateway` appends `:g<N>` to its
   gateway session key, so the next run does not reuse the bloated history.
4. **Stop and raise an attention item.** After N consecutive overflow failures
   of one agent on one issue (default 3, env `MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES`)
   the board escalates the issue through the existing stranded-issue recovery
   (board-owned recovery action blocks generic auto-recovery) with a comment
   listing the provider wording, run id and error excerpt. Remedy: reset or
   compact the session (run detail → reset task session), shorten the context
   or change the model, then wake the agent.

Not in this change: the model-catalog input limit checked before sending
(planned for 1.6.6) and idempotent turn recording inside the Hermes gateway.

Upstream #13891 (no duplicate wake context in the environment) is already
present (backport in P3, together with the bounded continuation history).
