# Guardrail enforcement modes (1.7)

Each guardrail rule of the 1.6.1 base layer can now run in one of three
enforcement modes, set in the board UI at the company, caste, or agent level
and applied **without a restart**: a mode change takes effect on the next
answer of the affected agent.

## Rules

| Rule | Detector surface | What it looks at |
|---|---|---|
| `secret` | `run_output` | The final text of a run (key/token patterns). |
| `pii` | `run_output` | The final text of a run (e-mail, phones, cards, СНИЛС/ИНН). |
| `injection` | `wake_queue` | An externally authored queued comment before the run reads it. |

Corporate-entity requisites are intentionally **not** a rule here — the owner
deferred that work.

## Modes

| Mode | Behavior at the evaluation point |
|---|---|
| `flag` (default) | Journal the event; change nothing. Exactly the 1.6.1 behavior. |
| `mask` | Journal the event (severity `warn`) and replace every matched span in the visible text with the neutral placeholder `[masked]`. The stored run/journal data is unchanged beyond the already-masked snippet. |
| `block` | Journal the event (severity `error`) and refuse the output: the answer is replaced with an operator-language refusal naming the rule, the hit count, and where the mode was set — never the matched values themselves. |

For the `injection` rule the enforcement happens in the wake queue: `block`
keeps the stored comment but replaces what the run's payload carries with a
refusal wrapper; `mask` replaces the text inside the payload's
`<untrusted-data>` markers. The board view of the comment never changes in any
mode.

## Precedence

The effective mode of a rule for one agent is resolved at every evaluation:

```
env force  >  agent  >  caste (role)  >  company  >  flag (default)
```

- Caste = the agent's role (`agents.role`).
- `MYRMIDON_GUARDRAILS_MODE_FORCE` is an **operator-only emergency lever**: when
  set to a valid mode (`flag`, `mask`, `block`) it forces that mode for every
  rule, every agent, overriding the UI settings. Anything else — unset, blank,
  a typo — means "no force"; a misconfigured value can never silently rewrite
  the blocking policy. This is the only environment variable of the feature.

Settings are re-read from the database at every evaluation (two primary-key
reads per run finalization); there is no cache and no restart gate.

## Where the settings live

The settings document is stored in `instance_settings.general.guardrailModes`
(same mechanism as the WIP limit, no dedicated table):

```json
{
  "company": { "secret": "mask" },
  "castes": { "engineer": { "pii": "flag" } },
  "agents": { "<agent-uuid>": { "injection": "block" } }
}
```

Only the keys you set are overrides; every unset key inherits. The schema is
strict: an unknown rule, mode, or nesting fails validation with 400 instead of
half-applying.

## UI

`Company Settings → Guardrails` (current UI, not the 2.0 shell):

- one row per rule for the company level, one select per rule;
- a caste picker with per-caste rules, and an agent table with per-agent rules;
- an **effective mode** column per agent — the resolved mode with its source
  (`env` / `agent` / `caste` / `company` / `default`), fetched from the server,
  not guessed client-side, so the screen shows the true precedence chain;
- the firing journal below: newest events with equality filters by rule
  (kind), severity, and run id.

API:

- `GET /api/myrmidon/companies/:companyId/guardrails/settings`
- `PUT /api/myrmidon/companies/:companyId/guardrails/settings` (instance admin)
- `GET /api/myrmidon/companies/:companyId/guardrails/resolve?agentId=…`
- `GET /api/myrmidon/companies/:companyId/guardrails/events?limit&kind&severity&surface&runId`

## Failure behavior

The mode resolution is fail-open by design: if the settings or the agent row
cannot be read, the rule resolves to `flag` (the default) and the run proceeds.
A guardrail can never break a run by failing to read its own policy.
