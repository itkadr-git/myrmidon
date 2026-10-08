# Evals: Cross-Family Judge Selection

Reference-task scores are produced by a judge model behind the company's LLM
gateway. Historically the judge ran on the configured `MYRMIDON_EVALS_MODEL`
(default `qwen-plus-free`), while most agents in the fleet also run on
DashScope/Qwen models — the judge was scoring "its own" family. Since
myrmidon 1.6.5 (OPE-4143, wave 1.6.2 backlog) the judge is picked from a
different model family than the agent being evaluated whenever the candidate
list allows it, and a collision is visible in the result.

## How the judge is chosen

1. The evaluated agent's model is resolved at run start from the task subject
   (`subjectModelFor` in `service.ts`); no client input or schema change is
   needed.
2. The judge candidate list (priority order, head = top priority) is resolved
   per run — no restart is needed to change it:
   - `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` (env, forced override), else
   - the built-in default list of gateway-served free models:
     `qwen-plus-free, qwen-max-free, qwen-turbo-free`
     (`SERVED_FREE_GATEWAY_MODELS` — every id is a model the gateway contract
     actually serves; unverified ids are not allowed in the default list).
3. `judgeCandidateOrder(agentModel, candidates, fallbackModel)` walks the list
   from the head and puts the first candidate whose family differs from the
   agent's family first. Families are resolved by an extensible table in
   `server/src/myrmidon/evals/model-family.ts` (`qwen`, `gpt`, `claude`, `glm`,
   `deepseek`, `kimi`, `gemini`, `llama`, `mistral`, `yi`, `phi`, `o1`, `o3`,
   …); a new family is one row in that table. Matching is token-anchored — a
   substring counts only at the start of the id or after `/ . _ -`, so
   `deepyida` is not `yi`, `chaos`/`cosmos` are not `o3`, `mystique`/`dolphin`
   are not `phi`.
4. When no candidate belongs to a different family, the run is still scored —
   the first candidate judges it, every task in `eval_runs.scores` carries
   `sameFamily: true`, and the server logs a warning naming the agent family,
   the agent model and the judge used.
5. A model without the `-free` suffix (a paid model) never enters the default
   list; it can only judge when the operator explicitly lists it in the
   setting. The configured `MYRMIDON_EVALS_MODEL` stays the judge when the run
   does not report an `agentModel` (nothing to differ from).
6. A gateway error (unreachable / HTTP error) of the selected judge does not
   abort the run: `createJudge` falls through to the next candidate and, when
   the whole priority chain fails, gives the configured `MYRMIDON_EVALS_MODEL`
   a last chance (its scores carry `sameFamily: true`). The run fails only if
   every attempt fails; the last error is then re-thrown.

## Where the flag is visible

- In the run record: `scores.tasks[].sameFamily` (per judged task).
- In the server log: the same-family fallback warning.
- The board UI badge (OPE-4150, child task) renders `sameFamily` from the
  stored scores.

## Related settings

See the `MYRMIDON_EVALS_*` table in `docs/myrmidon/SETTINGS.md`
(EVALS-JUDGE-FAMILY row) — Russian: `docs/myrmidon/SETTINGS.ru.md`.

## Tests

`server/src/myrmidon/evals/judge.family-selection.myrmidon.test.ts` covers the
acceptance criteria: the built-in default list only names gateway-served
models and resolves a cross-family judge for a non-qwen agent; a qwen agent
gets a non-qwen judge; a same-family collision still scores the run with the
flag and the warning; a gateway error on the selected judge falls through to
the next candidate and finally to the configured model (still scored, flagged
`sameFamily`); a paid model is never picked unless the operator listed it;
token-anchored family matching no longer fires on embedded `yi`/`o1`/`o3`/`phi`
substrings.
