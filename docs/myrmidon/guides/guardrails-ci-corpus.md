# GUARDRAILS false-positive eval on the reference corpus (CI check)

myrmidon(1.7-GRD-CI): blocking modes are never switched on blind. Before a
flag-only detector can become a blocker, CI must prove it does not fire on
clean text. This track wires the 1.6.1 reference corpus (GUARDRAILS part C, neutral
fixtures) into a per-rule precision/recall report and a blocking CI check:
any false block on a clean fixture turns the check red.

## How it works

1. The corpus (`server/src/myrmidon/guardrails/corpus/`) carries labelled
   cases: each case says which detector must fire (`expect.detector`:
   `secret`, `pii`, `injection`) or `null` for clean fixtures where nothing
   may fire.
2. The eval harness (`server/src/myrmidon/guardrails/eval/evaluate.ts`) runs
   every registered rule over every case and computes, per rule: support,
   TP/FP/FN, false blocks (a rule firing on a case with `expect.detector:
   null`), precision and recall. Scoring is pure — same code, same corpus,
   same numbers; the artifact is reproducible.
3. The rule registry (`server/src/myrmidon/guardrails/eval/rules.ts`) maps
   corpus detectors onto shipped detectors:
   - `injection` — the wake-queue heuristic scan at the shipped default
     threshold (0.6). The eval always measures the default; the runtime env
     override changes production behaviour only, never the artifact.
   - `secret` / `pii` — the output detectors of part A. Their
     module arrives with its own merge; until it is on the branch, the
     harness reports those rules as `pending-base-layer`: coverage is listed,
     the rules do not fire and cannot fail the gate. When the module
     appears, the rules activate with no change to this code.
4. The per-rule report is committed as a generated artifact next to the
   harness: `report.json` (machine-readable) and `report.md` (the same table
   for humans). The CI test (`eval.myrmidon.test.ts`) recomputes the report
   and fails on any drift — a detector change that shifts false positives or
   misses is impossible to merge without the diff of the artifact showing it.

## The gate

The blocking number is `totalFalseBlocks` — rules firing on clean fixtures.
Target: 0. The test asserts:

- zero false blocks across active rules (the acceptance criterion of
  the issue);
- the committed `report.json` / `report.md` equal the recomputed report;
- adding a knowingly false-positive rule turns the gate red (a regression
  tripwire: the same assertion fires the moment a real detector starts
  blocking a clean fixture);
- re-labelling a corpus case without refreshing the artifact fails the drift
  check too.

## Refreshing the artifact

After any change to a detector or to the corpus, regenerate deliberately:

```sh
pnpm --filter @paperclipai/server exec tsx \
  ../scripts/myrmidon/guardrails-eval/refresh.ts
```

The refresher refuses to write (exit 1) when the eval is red. Commit the two
report files in the same PR as the change that moved the numbers — that
review-time visibility is the point of the artifact.

Merge order with part A (`secret`/`pii` output detectors): those rules are
`pending-base-layer` until the part-A module lands on main, and activate on
merge. The branch that merges second refreshes the artifact on rebase (one
command above): on a part-A-merged base the drift check is red until the
committed report carries the active secret/pii rows. Whichever PR merges
second owns that refresh.

## What the report does not gate (yet)

Recall. The injection heuristic currently misses part of the corpus
(the per-subtype table in `report.md` names every missed case); recall is
reported, tracked in the artifact, and asserted only as "tp + fn = support".
Raising it is the job of the guardrail-modes track, which decides
per-rule blocking; the numbers this artifact prints are its evidence base.
False negatives never block a merge; false blocks always do.

## Configuration

None at runtime. The eval is a fixed measurement of the shipped defaults:
no env, no UI switch, no restart semantics — it runs in CI only. The
detectors themselves keep their own settings (see SETTINGS: `MYRMIDON_GUARDRAILS_*`).
