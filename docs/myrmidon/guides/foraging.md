# Foraging: knowledge gathering from approved sources (1.6 FORAGING)

> Russian version: [foraging.ru.md](foraging.ru.md)

Foraging lets the colony collect fresh knowledge from approved external
sources and turn the changes into skill candidates. An operator registers
sources per role; a periodic sweep re-reads each enabled source, compares it
with the stored snapshot and records every change as a finding; a finding the
skill lifecycle accepts becomes a skill candidate and then goes through the
usual lifecycle approval before any agent sees it.

The module is `server/src/myrmidon/foraging/` (the 1.6 FORAGING path); the
screen is `/foraging`, a sidebar item next to Quality.

## Off by default

Foraging ships DISABLED. The built-in default is off: without the instance
switch (`enabled` in the "Learning (foraging)" section of Instance → General,
key `general.foraging`) and without `MYRMIDON_FORAGING_ENABLED=1` as a forced
env override no timer is armed, no source is read; any other value keeps it
off, so a typo cannot turn the feature on. The switch is live — the sweep
re-resolves the settings row before every pass, so turning learning on or off
in the interface takes effect with the next pass, no restart
(FORAGING-LIMITS-UI, 1.6.4). The registry and the findings list stay readable
and editable while the sweep is off: the screen shows a note that passes are
not running, and the manual sweep answers `503` with `enabled: false`.

## The source registry

Each company keeps its own registry (the `foraging_sources` table, migration
`0290`). One row is one source for one role: `role`, `url`, `kind` (`url`,
`feed`, `repo`, `docs`), `enabled`, plus the last snapshot, the timestamps of
the last snapshot and the last check, and the last error. One source per
`(company, role, url)` — saving the same role+url again updates the row.

## How a pass works

One sweep pass over one company:

1. Take the enabled sources, least recently checked first.
2. Read each source (a plain `GET`; the answer is capped at 512 KB, a larger
   answer is cut, not rejected).
3. Normalize the text into one trimmed line per element (empty lines dropped,
   duplicates collapsed, order ignored) and compare with the stored snapshot.
   The first read of a source stores the baseline and opens no findings.
4. A change (added or removed lines, up to 50 lines per side) becomes a
   finding in `foraging_findings` with a one-line summary and the target
   skill key `foraged-<role>`.
5. A finding becomes a skill candidate only through the candidate port — the
   seam with the skill lifecycle (SKILL-LIFECYCLE). While the port is absent
   the finding stays `unverified`; when the lifecycle is connected, an
   accepted finding becomes `candidate` with a link to the candidate, a
   refused one becomes `rejected` with the reason.
6. Stop the pass when the cost estimate reaches the budget ceiling
   (`stopped_by_budget`). The stop is a normal outcome: the sources after the
   stop stay untouched and the next pass continues with them.

A source that fails writes its error on the row and the pass continues; a
broken source never stops the sweep. A pass that overlaps the previous one is
skipped, not queued.

The read is the only place the feature talks to the outside, and it carries
its own rules: a pause between two reads of one host
(`MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC`, default 60 s), an honest
User-Agent (`myrmidon-foraging/1.0`), and a breaker that leaves a host alone
for 6 hours after two failures in a row. The pause and the breaker are shared
by every company of the process, so two roles pointing at one host cannot
double the rate. When `MYRMIDON_FORAGING_KEY_SECRET` names a company secret,
its value goes as a bearer token; the value is read at call time and is never
logged or stored.

## Settings

Since 1.6.4 (FORAGING-LIMITS-UI) the operating parameters are **instance
settings**: the "Learning (foraging)" section of Instance → General
(`GET`/`PATCH /api/myrmidon/foraging-settings`, key `general.foraging`) holds
the enable switch, the pass interval, the same-host pause, the per-pass
budget, the daily and monthly company ceilings, the daily per-role and
per-agent ceilings, the hard/soft enforcement mode and the cost-per-task
auto-off threshold. The sweep re-resolves that row before **every** pass, so a
changed value applies with the next pass — no restart.

The environment variables do not go away: each one stays a **forced override**
of its field (UI value → env when set → built-in default), and the panel
shows which side is in force per field:

| Variable | Overrides | Default |
|---|---|---|
| `MYRMIDON_FORAGING_ENABLED` | `enabled` | off |
| `MYRMIDON_FORAGING_INTERVAL_SEC` | `intervalSec` | `3600` (60–86400) |
| `MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC` | `minHostIntervalSec` | `60` (≥ 5) |
| `MYRMIDON_FORAGING_BUDGET_CENTS` | `passBudgetCents` | `50` |
| `MYRMIDON_FORAGING_DAILY_BUDGET_CENTS` | `dailyBudgetCents` | unset (no limit) |
| `MYRMIDON_FORAGING_MONTHLY_BUDGET_CENTS` | `monthlyBudgetCents` | unset (no limit) |
| `MYRMIDON_FORAGING_ROLE_BUDGET_CENTS` | `roleBudgetCents` | unset (no limit) |
| `MYRMIDON_FORAGING_AGENT_BUDGET_CENTS` | `agentBudgetCents` | unset (no limit) |
| `MYRMIDON_FORAGING_ENFORCEMENT` | `enforcement` | `hard` |
| `MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS` | `autoOffCostPerTaskCents` | unset (check off) |

`MYRMIDON_FORAGING_KEY_SECRET` stays env-only: it is the **name** of a company
secret, not a limit, so it has no place in the settings row. Empty cents
field — no limit of that kind. The full table with bounds is in
[../SETTINGS.md](../SETTINGS.md).

When a limit stops a pass (sources after the stop stay untouched), a
`foraging_limit` card lands in the attention feed; soft mode marks it as a
question to the owner (raise the limit or switch learning off). When the mean
cost per task (BASELINE) rises above the auto-off threshold, learning
switches itself off and signals the same feed.

## The screen

The sidebar item «Foraging» (route `/foraging`) shows three things:

- the **source registry**, with an add form (role, url, kind), per-row state
  (last snapshot, last check, last error) and a delete button;
- the **findings** — each with the diff (`+N −M`), the summary, the target
  skill key, its state (`unverified` / `candidate` / `rejected`) and the
  candidate reference or the refusal reason;
- the **budget line** — the per-pass budget (or «no limit»), the estimated
  spend of the current UTC month, the pass interval and the same-host pause —
  plus a «Run sweep» button that starts one pass by hand (disabled while the
  feature is off).

The screen works while the sweep is off: the registry stays editable and the
findings stay readable, with a note that passes are not running.

## The API

All routes live under `/api/myrmidon/companies/:companyId/foraging`:

| Route | Who | What it does |
|---|---|---|
| `GET /sources` | company read | The registry plus whether the sweep is enabled |
| `PUT /sources` | board only | Adds or updates a source (`role`, `url`, `kind`, `enabled`) |
| `DELETE /sources/:sourceId` | board only | Removes a source |
| `GET /findings?limit` | company read | The findings, newest first (`limit` defaults to 50, maximum 200) |
| `GET /budget` | company read | The budget view for the screen |
| `GET /spend` | company read | The learning-spend breakdown (by role and source, last 90 days) behind the Costs "Training" line (FORAGING-LIMITS-UI) |
| `POST /sweep` | board only | Runs one pass by hand; answers `503 {enabled: false}` while the sweep is off |

The limits themselves live outside the company routes:
`GET`/`PATCH /api/myrmidon/foraging-settings` (instance settings, board-org
access / instance admin) read and write `general.foraging`.

Reads need company access; the mutations need a board actor — the manual
sweep spends real external reads. Every mutation writes an activity-log row
(`myrmidon.foraging.source_saved`, `myrmidon.foraging.source_removed`,
`myrmidon.foraging.sweep_run`).

## From a finding to an agent

Nothing a source says reaches an agent directly. A finding with a diff goes
to the skill lifecycle through the candidate port; an accepted candidate
skill then follows the lifecycle rules (`candidate` reaches only the pilot
agents of `MYRMIDON_SKILL_PILOT_AGENTS`, promotion is approval-gated) and is
reviewed on the skill lifecycle screen (`/skills/lifecycle`) before it
reaches everyone.
