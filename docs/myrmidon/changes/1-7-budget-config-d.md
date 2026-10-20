---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` | 1.7 BUDGET-CONFIG | unset | Forces budget-limit resolution into signal-only mode: limit overruns are reported but do not enforce a hard stop. When unset, the live stored `general.budgetLimits.signalOnly` setting applies, then the code default. Read on each resolution; no restart is needed | Only the documented true/false forms are accepted; invalid values do not force an override. See the budget limits API and stored setting for live control |

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | DISTILL | unset | Comma-separated distillation categories accepted automatically; unlisted categories still require review | Unset/empty — manual review for every category |
| `MYRMIDON_DISTILL_GATEWAY_URL` | DISTILL | unset | LiteLLM-compatible gateway endpoint used for distillation requests | Unset — distillation cannot call a gateway |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | DISTILL | `60` | Minimum interval between distillation passes | Invalid or non-positive values use the default |
| `MYRMIDON_DISTILL_KEY_SECRET` | DISTILL | unset | Name of the secret containing the gateway key; the secret value is never logged | Unset — no gateway credential is available |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | DISTILL | `300` | Maximum duration of one distillation task | Invalid or non-positive values use the default |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | DISTILL | `32000` | Maximum input tokens sent to a distillation request | Invalid or non-positive values use the default |
| `MYRMIDON_DISTILL_MAX_TASKS` | DISTILL | `10` | Maximum tasks processed in one distillation pass | Invalid or non-positive values use the default |
| `MYRMIDON_DISTILL_MODEL` | DISTILL | unset | Model identifier used for distillation | Unset — distillation model must be configured elsewhere |
| `MYRMIDON_DISTILL_WINDOW_SEC` | DISTILL | `3600` | Lookback window for eligible distillation work | Invalid or non-positive values use the default |

The budget-limits API exposes `GET /api/myrmidon/companies/:companyId/budget-limits/effective/:issueId`. It resolves the active issue limit using issue, foraging, caste, project nest, then company nest precedence and returns the selected amount, period, mode, and source metadata. PUT rejects project and issue refs outside the requested company.
