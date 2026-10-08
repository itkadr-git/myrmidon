# Asymmetric debates: generator, critic, and a judge outside the dispute (1.7 DEBATE-ASYM A)

> Russian version: [debate-asym.ru.md](debate-asym.ru.md)

A single model grading its own answer is not a review — it is an echo. The
debate engine runs a structured disagreement about one task question between
models of **different families**, so a blind spot of one vendor is attacked by
another:

| Role | Pole | Rule |
|---|---|---|
| **Generator** | constructive | proposes and then defends the best concrete answer |
| **Critic** | adversarial | hunts every error, omission and risky assumption; its prompt says it is penalized for a missed error, so it does not soften. When nothing remains unresolved it writes `[AGREE]` and the exchange stops |
| **Judge** | outside | a third family: reads the whole transcript and delivers the verdict plus the answer — it does not take a side |

The two first answers are **independent**: the critic states its own position
before ever seeing the generator's, so the critique is not anchored to it.
The exchange runs at most **three rounds**; it stops early on agreement, or on
the **token ceiling** (the ceiling is shared across all calls of the debate).
The result — every position, the judge's verdict, and the **cost** — is written
onto the task as the `debate-result` document, and the spend is recorded as
task-level cost events, so the budget enforcement of BUDGET-CONFIG counts the
debate like any other work.

## The cross-family rule

`getModelFamily()` maps a model id to its family through one extensible table
(the same rules EVALS-JUDGE-FAMILY introduced for evals). A configuration is
refused — before a single call, before anything is stored — when:

- the generator and the critic share one family (`qwen-plus-free` vs
  `qwen-turbo-free` is the same vendor; debates must be asymmetric), or
- the judge shares a family with either debater (the judge must sit outside
  the dispute).

An id the table does not know is family `unknown`; two unknowns are treated as
different vendors — the check is strict about known collisions, conservative
about refusals.

## Where it is set

The screen is **Instance → General → Asymmetric debates** (next to the budget
enforcement panel), and the API is `GET`/`PATCH /api/myrmidon/debate/settings`
(GET is board-readable, PATCH is instance-admin only). Saving writes
`instance_settings.general.debate` and applies at the **next debate run — no
restart**: the configuration is read at run time, never cached at boot. The
effective value's source is shown next to the form: *Saved here* / *Forced by
the server environment* / *Built-in default*.

| Level | Value |
|---|---|
| Stored settings | what the screen saved — the source of truth once saved |
| `MYRMIDON_DEBATE_CONFIG` | forced JSON override for an instance that never saved anything |
| Built-in default | free models, one family each: `qwen-plus-free` generator, `glm-4-flash-free` critic, `deepseek-chat-free` judge; 3 rounds; 50 000 tokens ceiling |

A malformed or symmetric value at any level is reported as the reason and
refused — never silently replaced by the next level.

The gateway contour (the chat-completions address and the *name* of the
company secret holding the key) reads `MYRMIDON_DEBATE_BASE_URL` /
`MYRMIDON_DEBATE_KEY_SECRET` first and falls back to the evals contour
(`MYRMIDON_EVALS_*`). While neither resolves, the run endpoint answers 503
with the reason and the settings screen shows it, so the board can say why the
button would refuse.

## Starting a debate for a task

```
POST /api/myrmidon/companies/{companyId}/debates/issues/{issueId}/run
```

Body is optional: `{ "question": "..." }`; without it the task title is the
question. Both the board and an agent may call it, per the autonomy matrix
(owner rule): the board is not subject to the matrix; an agent is gated on the
`spend_above_threshold` action class — a debate spends gateway calls.
`forbidden` answers 403 (`autonomy_forbidden`), `approval_required` answers 403
with `autonomy_approval_required` (the same interim shape the other
enforcement routes use until the held-action follow-up for invocation-less
routes exists).

On success the response carries the full outcome (rounds run, stop reason,
tokens against the ceiling, cost breakdown per role and per model) and the
`debate-result` document is on the task — positions, verdict, cost included.
Errors are mapped by kind: 422 with the exact family-collision reason when the
configuration is symmetric, 503 when the gateway contour or the key secret is
not available, 502 when the gateway itself fails.

## Cost and the budget contour

Every call is priced by its role config (`inputCentsPer1k` /
`outputCentsPer1k`, absent = free = 0) against the usage the gateway reports
— a character/4 estimate when a gateway omits `usage`. The cost breakdown
appears in the result document per role and as a total, and each role's spend
is written as one `cost_events` row (billing code `myrmidon-debate`, issue id
of the task, the calling agent when the run was agent-initiated) — the same
table BUDGET-CONFIG enforcement reads, so debate spend counts at the task
level like any other work.

One subtlety: the call that crossed the token ceiling is **not charged** — its
cost is recorded separately as `ceilingCrossedCents` and shown in the
document, but it stays out of the total and out of the cost events, so a
ceiling really means "you spend no more than this". A board-initiated run
(without an agent identity) writes no cost rows (the table is agent-scoped);
its spend is carried by the activity log and the document.

## Tests

The engine is pure — every model call goes through one `call` port — so the
acceptance rules run verbatim against fakes:
`packages/shared/src/myrmidon-debate.test.ts` (rejection of a symmetric
configuration, the third-round and ceiling stops, the cost in the document),
and `server/src/myrmidon/debates/{service,gateway,settings}.myrmidon.test.ts`
(the service flow, the gateway contour, the live settings precedence).
