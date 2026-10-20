---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` | 1.7 BUDGET-CONFIG | unset | Forces budget-limit resolution into signal-only mode: limit overruns are reported but do not enforce a hard stop. When unset, the live stored `general.budgetLimits.signalOnly` setting applies, then the code default. Read on each resolution; no restart is needed | Only the documented true/false forms are accepted; invalid values do not force an override. See the budget limits API and stored setting for live control |
