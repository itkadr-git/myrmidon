# Knowledge and learning

> Русская версия: [Knowledge-and-learning.ru](Knowledge-and-learning.ru)

A team that does not learn is a static program. Myrmidon has three connected
mechanisms for keeping the team's knowledge fresh and measuring whether the
team actually got better: regulations, foraging and evals.

## Regulations: the company wiki

Per-role regulations — the written rules a role works by — live in the same
store as the [autonomy matrix](Safety-and-guardrails), with
draft → approved revisions and a change log. An approved regulation is what
agents of that role are expected to follow; editing one is a deliberate,
reviewed act, not a quiet file change.

## Foraging: gathering fresh knowledge

Foraging lets the colony collect fresh knowledge from approved external
sources and turn the changes into skill candidates. An operator registers
sources per role; a periodic sweep re-reads each enabled source, compares it
with the stored snapshot and records every change as a finding; a finding
the skill lifecycle accepts becomes a skill candidate and goes through the
usual lifecycle approval before any agent sees it.

The feature ships **disabled**: without the instance switch and without the
forced env override, no timer is armed and no source is read — a typo cannot
turn the feature on. The switch is live: turning learning on or off in the
interface takes effect with the next sweep pass, no restart. A pass stops
when its cost estimate reaches the budget ceiling, and the stop is a normal
outcome — the remaining sources continue on the next pass.

## Evals: did we get better?

Changing a skill, a model or a role's instructions used to be a guess. The
evals path makes the question computable: a seeded corpus of neutral
reference tasks for the pilot role, an LLM judge behind the company's
gateway, and a threshold-plus-repeat verdict that says whether the change
improved the role or not.

The judge is selected deliberately across model families: a judge scoring
"its own" family flatters the result, so the evals configuration picks a
judge from a different family than the agents under test.

## Quality metrics and baselines

The Quality screen shows the six delivery metrics of a window, per project
and per role, and compares the window against the company's pinned baseline
snapshot with per-row deltas — so a regression in delivery speed or rework
rate is visible as a number, not a feeling.

## In detail

- [Foraging: knowledge gathering from approved sources](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/foraging.md)
- [Reference-task evals and the LLM judge](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/reference-task-evals.md)
- [Evals: cross-family judge selection](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/evals-judge-family-selection.md)
- [Baseline comparison on the Quality screen](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/baseline-comparison.md)
- Regulations store: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), section «AUTONOMY-MATRIX»
