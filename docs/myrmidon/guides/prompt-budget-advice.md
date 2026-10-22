# Prompt budget advice and deep analysis

> Russian version: [prompt-budget-advice.ru.md](prompt-budget-advice.ru.md)

The agent card answers two questions about the last run's prompt: which part
of it dominates, and what to do about it. A static advisor computes concrete
recommendations on request from the recorded per-part token breakdown, and a
"Deep analysis" button files a task for a cheap-model optimizer agent, which
drafts instruction edits as a comment on that task. Nothing is scheduled and
nothing is changed automatically: the advice is computed when the card is
opened, and the deep pass starts only on the operator's click.

## Where the surface lives

The "Prompt budget advice" panel sits on the agent card's Overview tab,
directly under the "Latest run" card. It reads only its own advice endpoints,
so it mounts and works on its own; the panel does not depend on the
prompt-budget signal of the thresholds part of the same release.

## What the panel shows

The panel is a pure view of the advice body. Its states:

- While loading: "Loading the prompt breakdown...".
- The agent has no run with a recorded prompt breakdown yet: the line "No run
  of this agent has a recorded prompt breakdown yet." and the "Deep analysis"
  button stays disabled.
- A breakdown exists: a header line "Last run <runId> · <total> tokens in the
  prompt", then the per-part list — biggest part first, each row showing the
  part key, its tokens (short form: `1.5k` for thousands) and its share
  (whole percents stay whole, fractions keep one digit). Ties in token count
  are broken by part key, so the order is stable across runs.
- No part crosses the warning threshold (or the prompt is smaller than 2000
  tokens): "No part of the last prompt crosses the warning threshold." — the
  body marks this as `healthy: true`.
- One or more parts cross the threshold: a card per recommendation with a
  severity badge, the rule title, the part key with its share and tokens, and
  the concrete action. Severity is **Warning** from a 30% share of the prompt
  and **Critical** from 50% (red badge); both severities render the same
  card, the badge differs.

The panel fetches once when it mounts (`retry: false`, no polling): the
numbers are the last run as recorded, not a live feed.

## The recommendation rules

The advisor is a pure function over one run's breakdown
(`server/src/myrmidon/prompt-budget-advice/advice.ts`) — it never touches the
database and never calls a model. A rule table maps the dominant part to a
concrete action; every rule matches a part key case-insensitively, the first
matching rule describes the part, and the last entry is a fallback, so a
renamed or newly added part still gets the generic recommendation. The
thresholds are code constants, not settings:

| Constant | Value | Meaning |
|---|---|---|
| `PROMPT_BUDGET_ADVICE_SHARE_PCT` | `30` | A part is worth a recommendation from this share of the prompt (percent) |
| `PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT` | `50` | A part this large is Critical rather than Warning (percent) |
| `PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS` | `2000` | Below this total the prompt is small regardless of shares — no advice at all |

The rule table, in match order:

| Rule | Matches part keys like | Title | Action |
|---|---|---|---|
| `instructions` | `instruction`, `system`, `identity`, `contract`, `bundle`, `preamble`, `prompt-file`, `agent-card` | Instructions bundle | Move reference material out of the always-on instructions bundle into skills loaded on demand; keep only the operating rules in the bundle. |
| `skills` | `skill`, `inject` | Skills and injections | Turn off the skills this agent does not need on every run, or move their bodies behind an on-demand lookup. |
| `session-history` | `session`, `handoff`, `history`, `continuation`, `transcript`, `conversation` | Session history and handoff | Use a run-scoped session strategy instead of an issue-scoped one, and compress the handoff instead of carrying the whole history. |
| `tool-results` | `tool`, `result`, `output`, `attachment`, `artifact`, `file-content` | Tool results and attachments | Trim tool results and attachments before they enter the prompt: ask for less output, summarise large payloads, keep files out of the context. |
| `wake-payload` | `wake-payload`, `payload`, `wake-json` | Wake payload JSON | Shrink the wake payload the wake-up carries: fewer fields, no bulky embedded JSON. |
| `task-markdown` | `task`, `issue-markdown`, `issue-description`, `issue-body`, `description` | Task markdown | Shorten the task markdown carried into the prompt: link to the document instead of pasting it. |
| `wake-prompt` | `wake` | Wake prompt | Trim the wake prompt scaffolding: the repeated boilerplate around the actual request. |
| `generic` | everything else | Dominant prompt part | Review this part: it is the largest share of the prompt; cut what is not needed on every run. |

## Where the breakdown comes from

The advisor reads the agent's recent runs (at most 20, newest first by finish
time — `PROMPT_BUDGET_ADVICE_SCAN_LIMIT`) and takes the first one that
carries a usable figure: the per-part breakdown recorded by the gateway
(`usageJson.promptBreakdown` of the `heartbeat_runs` row), or — when no
breakdown exists — the recorded input-token total without parts (a run that
did not go through the gateway still yields a total, so it can be warned
about). There is no new table and no migration: the breakdown lives in the
existing `heartbeat_runs.usage_json` column. An agent with no usable run at
all answers with `hasRun: false`.

## The "Deep analysis" button

The static advice is cheap and mechanical; the deep pass is a real agent run
on a cheap model. The button is an operator action: the POST route requires
board access to the company. One click files a board task:

- Title `Prompt budget deep analysis: <agent name>`, priority medium, status
  `todo`, assigned to the configured optimizer agent.
- The description carries the target agent (id, name, model as set on the
  card — "not set on the card" when none), the last run's breakdown as a
  table, the recommendations already produced statically, and the
  instructions: name the dominating parts, produce a DRAFT of concrete edits
  (what changes, the exact text or setting, the expected token saving), and
  post that draft as a single comment on the task. The task's constraints
  forbid the optimizer from changing any configuration itself — it only
  produces a draft for a human to review, so the deep pass cannot silently
  edit another agent.
- The task carries the dedup key `prompt-budget-advice:<agentId>:<runId>` —
  one deep task per target agent per run; a repeated click on the same run
  does not pile up duplicates.

After the task is filed the panel shows "Deep analysis task:" with a link to
it (`/issues/<identifier>`, falling back to the task id while no identifier
exists). While the POST is in flight the button reads "Filing the task..."
and is disabled.

The optimizer agent is the additive field `promptBudget.optimizerAgentId` of
the instance general settings area owned by the thresholds part of the same
release (see [../SETTINGS.md](../SETTINGS.md)); there is no environment
variable. The deep POST refuses with 422 and a clear message when:

- no optimizer agent is configured (the field is absent, blank or not a
  uuid);
- the configured optimizer is the analysed agent itself;
- the configured optimizer is not an agent of this company;
- the target agent has no recorded run with a prompt breakdown to analyse.

## API

| Route | Access | Answer |
|---|---|---|
| `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice` | company member | `{ agentId, agentName, model, hasRun, runId, total, parts, healthy, recommendations }` |
| `POST /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice/deep` | board | `201 { issueId, identifier, title }`; `422` with a clear message when the optimizer is missing or unusable; `404` when the agent is not one of the company |

Both paths sit under the prompt-budget prefix of the same release but carry
their own `/agents/:agentId/advice` tail, so they never touch the settings or
status routes of the thresholds part.

## Settings

| Field | Default | What it does |
|---|---|---|
| `promptBudget.optimizerAgentId` | absent | Agent that receives the deep-analysis task filed by the "Deep analysis" button — a uuid of another agent of the same company; absent, blank or not a uuid answers the deep POST with 422. No environment variable |

The thresholds (30% / 50% / 2000 tokens) are code constants of
`server/src/myrmidon/prompt-budget-advice/advice.ts`, not settings — they
decide when advice is worth showing, not what the product policy is.
