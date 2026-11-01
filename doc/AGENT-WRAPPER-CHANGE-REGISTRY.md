# Agent Wrapper Change Registry

This registry records changes to the instructions and guardrails surrounding agents: `AGENTS.md`, shared skills, memory, tool guidance, and other guardrails. It is the local equivalent of an `EXPERIENCE.md` log for wrapper changes.

## Operating rules

- A wrapper change must have a measurable result before it can be marked `confirmed`.
- `proposed` and `measured` are not confirmation: `measured` means the comparison was run, while `confirmed` means the evidence supports the hypothesis. Use `rejected` when it does not.
- Every result must name the before/after evidence or explicitly say `not measured`; do not turn an absent result into a success claim.
- A change copied into `AGENTS.md` without a result may remain there for at most 2 weeks. Before the limit, measure it or remove/revert it. Record the measurement or rollback in this registry.
- The benchmark set must be stable for a comparison. Record its task identifiers or a reproducible selection rule, and keep the metric definition unchanged between before and after runs.

## Fields

| Field | Meaning |
| --- | --- |
| Date | Date the wrapper change landed or was proposed (`YYYY-MM-DD`). |
| Component | `AGENTS.md`, `skill`, `memory`, `tool guidance`, or `guardrails`. |
| Hypothesis | Expected reduction in a named failure mode, phrased as “should reduce the share of X”. |
| Measurement metric | Numerator, denominator, and direction of improvement. |
| Benchmark set | Stable task IDs or a reproducible task-selection rule. |
| Before / after result | Observed values, or `not measured` when evidence is not yet available. |
| Status | Exactly one of `proposed`, `measured`, `confirmed`, or `rejected`. |
| Evidence / owner | Commit, issue, run, or follow-up owner needed to reproduce or complete measurement. |

## Registry

| Date | Component | Hypothesis | Measurement metric | Benchmark set | Before / after result | Status | Evidence / owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-08 | skill (`skills/paperclip/`, later `skills/myrmidon/`) | Renaming Paperclip-facing skill guidance to Myrmidon should reduce terminology drift and incorrect product-name references in agent-facing outputs. | Share of sampled agent-facing outputs containing the retired product name where Myrmidon is intended; lower is better. | OPE-846, OPE-7527 and the next 10 agent-facing skill tasks after the rename. | not measured / not measured | proposed | `44cdff18e`, `dd737ed36`; owner: task maintainer |
| 2026-10-09 | skill (`skills/devbuild/SKILL.md`) | Explicit env-delivered devbuild-key and startup self-check guidance should reduce runs that fail late because a key or heap limit is missing. | Late setup failures attributable to missing key/heap guardrail per 10 devbuild tasks; lower is better. | OPE-6608 and the next 10 devbuild-in-bot tasks. | not measured / not measured | proposed | `c7bbb1bdf`, `24ff18d79`; owner: devbuild maintainer |
| 2026-10-10 | skill (`skills/paperclip/SKILL.md`) | Documenting pheromone-based task casting and swarm wake admission should reduce duplicate claims and unassigned-task wakeups. | Duplicate-claim or unassigned-wakeup incidents per 100 swarm wakes; lower is better. | OPE-6614 and OPE-6608, plus the next 20 swarm-wake tasks. | not measured / not measured | proposed | `d265b6e75`, `33438bd80`; owner: Myrmidon maintainer |
| 2026-10-19 | skill (`skills/myrmidon/SKILL.md`, `references/owner-dialogue.md`) | Runtime-aware owner-message transport guidance should reduce missed or misrouted owner decisions. | Owner-decision messages correctly delivered and actionable divided by all owner decisions; higher is better. | OPE-1426 and the next 10 owner-decision tasks. | not measured / not measured | proposed | `96b40edc3`; owner: Myrmidon maintainer |

## Measurement protocol

For each entry, run the same benchmark set against the same metric before and after the wrapper change, record raw counts and dates in this table, then update the status. A result is complete only when both before and after values are present and the evidence link or commit is recorded. If the hypothesis fails, mark `rejected` rather than rewriting it. Review `proposed` entries weekly; any change present in `AGENTS.md` for more than 2 weeks without a result must be measured or rolled back and annotated here.
