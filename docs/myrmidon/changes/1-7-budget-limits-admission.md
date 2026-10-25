# 1.7 BUDGET-CONFIG: hierarchy limits act on run admission (OPE-7911)

## what

The per-level spend limits of BUDGET-CONFIG A (`budget_limits`) now take
effect on run admission in the queue. Until this change the rows were
configurable — the Budgets screen, the journal, the usage view and the
effective-limit resolver — but nothing on the run path read them; only the
vendor `budget_policies` arms of `getInvocationBlock` did. This closes the
epic's queue-side acceptance: a limit change acts on the next admission of
the next run, within a minute, no restart.

## how it decides

Every admission (`getInvocationBlock`, the same gate the vendor budget
policies and the quota gate already use) resolves fresh from the database:

1. the effective limit for the issue — issue → foraging → caste → project
   nest → company nest, the resolver's precedence (deepest wins);
2. the spend of that limit's own level, ref and period (the spend is counted
   at the source level, never re-derived at a shallower one);
3. the limit row's own mode and the global "signal only" flag
   (`instance_settings.general.budgetLimits`, env override
   `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY`).

Only a **hard, active** limit whose period spend is strictly over its amount
refuses the run, with a reason naming the level, the spend and the limit
(`Budget limit exceeded for caste engineer: spent $6.00 of the $5.00 limit
…`). Soft rows never refuse on admission (the B pause machinery owns soft);
signal-only (the corrupt-data-safe default, ON) never refuses at all.
Raising the limit through the screen (or the API) lets the very next
admission through — there is no cache.

## wiring

- `server/src/myrmidon/budget-limits/admission.ts` — the decision core
  (`decideBudgetLimitAdmission`, pure) and the db-backed evaluator
  (`evaluateBudgetLimitAdmission`).
- `budgetService` gains an optional hook
  `resolveBudgetLimitAdmissionBlock`; absent = vendor behaviour (nothing
  blocks, the same optionality B used for its mode hook).
- `heartbeat.ts` wires the hook for the real server (the queue, the wakeup
  request gate and the plugin wakeup paths all call
  `getInvocationBlock`, so they inherit the gate).

## tests

- `admission.unit.test.ts` — the decision core: over/equal boundary,
  signal-only, soft, no-limit, level→scope mapping, period wording.
- `admission.db.myrmidon.test.ts` — against embedded postgres through the
  real `budgetService`: deeper level wins, the raise-through-the-store
  frees the next admission (the "within a minute" acceptance), the default
  signal-only never refuses while enforce does, and an absent hook keeps
  the vendor behaviour.
