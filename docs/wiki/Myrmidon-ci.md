# Myrmidon CI

> Русская версия: [Myrmidon-ci.ru](Myrmidon-ci.ru)

For draft pull requests, `opened`, `reopened`, and `synchronize` omit the expensive Myrmidon CI jobs, including planning, build, tests and checks. Moving the PR to ready emits `ready_for_review` and starts normal CI on the current head. The skipped draft summary is named `draft CI omitted`, not `CI result`: a missing `CI result` is not a green merge gate. A ready PR needs the actual required `CI result` verdict.

To dispatch Myrmidon CI manually, use Actions → Myrmidon CI → Run workflow and provide a non-blank `reason`. The `plan` job records the reason in the Actions job summary; an empty or whitespace-only reason fails planning. Manual dispatch runs the full tier.

Pushes to `main` and `merge_group` checks continue to run the full tier. Release tags use the separate tag workflow, unchanged by this gate. See the [CI runbook](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/ci.md) and [workflow](https://github.com/itkadr-git/myrmidon/blob/main/.github/workflows/myrmidon-ci.yml).

## Change log

20.11.2026 — Draft PRs omit expensive CI until ready; manual dispatch requires a recorded reason. OPE-15275, PR #4624.
