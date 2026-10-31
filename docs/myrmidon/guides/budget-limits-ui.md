# Spend limits per level: the owner's screen (1.7 BUDGET-CONFIG D)

The "Budgets" screen is where the owner sets and changes the spend limits of
[the hierarchy](budget-limits.md) and sees the spend against each limit. It
lives in the current board UI at **Company settings → Budgets**
(`/company/settings/budgets`), the code is
`ui/src/components/myrmidon/budget-limits/`.

## The tree

One row per level, the same `(company, level, ref)` triples the API stores:

| Level | Rows the screen shows |
|---|---|
| Nest | the whole company, and one row per project of the company |
| Caste | one row per caste that has a limit (a new caste is added by its role key) |
| Foraging | the single foraging pass |
| Task | one row per task that has a limit (a new one is added by the issue id) |

Each row carries the amount, the period (`Calendar month (UTC)` or
`Lifetime`), the mode (`Hard: refuse` or `Soft: pause and ask`) and the spend
of the period against the limit: `$600.00 / $500.00 (120% used)`, marked
**Over the limit** when it is crossed. A row without a limit says *No limit* —
the owner sets one right there.

Editing is in place: change the amount, the period or the mode and press
**Save** on that row. **Create** writes the first limit of a row that has
none; **Remove** deletes the stored limit (its history stays in the journal).
Every save goes straight to the running API — no restart, no page reload: the
row, its spend and the journal entry all refresh from the server.

## Signal only

The switch at the top of the screen is the global mode the owner owns: while
it is on, crossing a limit signals and blocks nothing. The screen shows both
the effective value and **where it comes from**:

- *Default value — nothing saved yet* — the mode is on because nobody saved a
  choice;
- *Saved in the settings* — the owner's own choice;
- *Forced by the server environment — the switch is locked* — the environment
  variable wins and the switch is disabled, so a stale screen cannot overwrite
  it ([budget-limits.md](budget-limits.md) names the variable).

The switch saves with `PATCH …/budget-limits/signal-only` (board only) and
applies immediately.

## The change journal

The bottom table is the journal of the limits: when, who (the actor id), what
(created / updated / deleted), which level and value, and the amount move
("Was $500.00, became $750.00"). It is append-only and newest first — a
deleted limit keeps its rows.

## Reading the screen

- Readers with company access see the tree, the spend and the journal.
- The mutations (amount, period, mode, remove, signal only) need a board
  actor; without that right the API refuses them and the screen shows the
  reason.

## Tests

`ui/src/components/myrmidon/budget-limits/budgetLimitsConfig.myrmidon.test.ts`
(the tree, the amount and ref parsing), `…/BudgetLimitsScreen.myrmidon.test.tsx`
(the rows, in-place edit, the switch with its source, the journal) and
`…/BudgetLimitsScreenContainer.myrmidon.test.tsx` (the reads, the PUT of an
edited limit with the refetch of the tree, the PATCH of the mode, the DELETE).