# Merge queue

> Russian version: [merge-queue.ru.md](merge-queue.ru.md)

GitHub merge queue for `main`. It exists because on 06.10 `main` went red twice by stitching
together PRs that were each green on their own: between
"CI passed on the PR" and "merge into `main`", `main` moved. The queue closes that window
(task OPE-5500).

## How it works

`main-protection` keeps requiring on the PR head: `CI result` and `hot-files-review`. A PR head
green alone is not enough to enter the queue — the same checks are re-run on the **candidate
commit**: `main` plus all PRs queued ahead of yours. Only when the candidate is green does
GitHub push it to `main` — and immediately starts checking the next group with your commit
already in `main`. Merges are therefore serial, and `main` stays green.

The queue is configured in the repository settings (branch `main`, merge method **merge
commit**; queue rules are the owner's call under Settings → Merge queue). The queue itself
orders PRs and builds candidate commits; what it pushes to `main` is an ordinary merge
commit, so `main` history stays fit for the usual parsing (`git log main`) — no release gate
depends on every `main` commit having exactly one parent.

## What CI does on a queue event

- `myrmidon-ci.yml` has a `merge_group: types: [checks_requested]` trigger. The `plan` step for
  a merge-group event diffs `merge_group.base_sha..head_sha` — the same diff the PR was checked
  with, on top of the fresh `main`; tier and test selection work as for a PR. The checks that
  run are the same as on a PR (`plan`, `typecheck`, `build`, `tests-affected`, `ci-result`),
  under the same job names, so the `main-protection` ruleset requirements are met on the
  candidate. If an earlier group lands while your checks are running, GitHub re-requests
  checks on a new candidate — the same code, a new base.
- A `merge_group` CI run is **never auto-cancelled**: the concurrency group is fixed for the
  event (`myrmidon-ci-refs/heads/gh-readonly-queue/main/pr-<n>-<sha>`, one per entry — unlike
  pull events, merge_group does not expose `github.run_id` in a concurrency group) and
  `cancel-in-progress` is off. A cancelled queue run removes the group from the queue, so
  the cancellation itself would be a loss; the PR head and the previous candidate still get
  cancelled as usual.
- `myrmidon-hot-files-review.yml` also fires on `merge_group`, but review is enforced on the
  PR: the job just reports `hot-files-review` as success on the candidate commit and exits, so
  the gate does not hold up the queue.

## Process: reviewer and steward

1. The **reviewer** (adm-dev-review or the maintainer) reads the diff, checks that the test
   fails without the change, and sets the `review-approved` label on the PR (for hot files this
   is what turns `hot-files-review` green — see [CONVENTIONS.md](CONVENTIONS.md), section 6).
   A new push removes the label and review starts over.
2. The **steward** (the role that merges) sends an approved PR with green CI on its head into
   the queue:

   ```bash
   gh pr merge --auto --merge <PR>
   ```

   `--auto` enqueues rather than merging immediately; GitHub itself picks the moment and builds
   the candidate.
3. GitHub re-checks the candidate against the fresh `main`. Green — the PR is merged into `main`
   and closed. Not green — the PR leaves the queue and returns to `open`.

## If a PR leaves the queue

The PR is returned to the author with failed checks on the candidate commit:

1. Open the failed `CI result` / run of the `merge_group` event and look at the lane that fell
   (the format is the same as PR CI — see [ci.md](ci.md)).
2. Reproduce locally: rebase the branch onto the current `main` and run the affected lanes.
   A collision between two neighbouring PRs is not a "flaky test": whoever entered the queue
   later fixes the conflict.
3. Push the fix, wait for PR CI to go green, re-set the `review-approved` label (the push
   removes it), and the steward re-enqueues with `gh pr merge --auto --merge` again.

If the queue itself stalls (candidate checks are not starting), first check the
`merge_group` trigger in `myrmidon-ci.yml` and the `CI result` check name, then the queue
settings of the `main` branch in repository settings.

## Without a GitHub queue: PR auto-update

**The queue above is not available in this repository.** It belongs to a user account
(`owner.type=User`), and GitHub rejects the `merge_queue` rule for it (422). The goal stays the
same: PRs do not go stale and land on top of a fresh `main` without manual work. It is done by
three parts.

1. **Ruleset `main-protection`**: `strict_required_status_checks_policy=true`. A PR cannot merge
   until its branch contains the current `main`, so a combination of PRs that were never tested
   together cannot land.
2. **Workflow `myrmidon-pr-autoupdate.yml`** (on push to `main`, every 30 minutes, and
   `workflow_dispatch`; one run at a time, never cancelled). It takes open PRs into `main` with
   auto-merge on (`gh pr merge --squash --auto`) from this repository (not forks):
   - behind `main` (`compare` `behind_by > 0`): `PUT /pulls/{n}/update-branch` with
     `expected_head_sha` (a merge update). At most **one PR per run**, the oldest first: updating
     all at once would start a CI run for each and every merge would make the rest stale again.
     The next PR is taken on the next push to `main` (the merge of the first one) or by the
     30-minute schedule;
   - in conflict (`mergeable_state=dirty`): not touched. The label `needs-rebase` (created if it
     does not exist) and one comment with a hidden marker are set; when the conflict is gone, the
     label is removed and the comment is marked resolved.
3. **Checks on the new head.** A push made with `GITHUB_TOKEN` does not start `pull_request`
   workflows (GitHub rule against recursive runs; only `workflow_dispatch` and
   `repository_dispatch` are exempt). The repository has no PAT or App token (`gh secret list`
   shows only workflow secrets), and a stored PAT would be a new long-lived credential with write
   access. So the workflow dispatches the required checks itself after each update:
   - `myrmidon-ci.yml` on the PR branch (`workflow_dispatch`). It reports `CI result` on the new
     head under the same name, so the ruleset requirement is met. Note: a manual run is the
     **full** tier, heavier than the `fast` PR tier;
   - `myrmidon-hot-files-review.yml` with the PR number (a new `workflow_dispatch` trigger). It
     posts the `hot-files-review` status on the new head. This is not a `synchronize`, so the
     `review-approved` label stays: merging `main` in does not change the code the reviewer saw.

   If an update ever has to run with a PAT or an App token instead, replace `github.token` and the
   two dispatch calls with that token; `pull_request` workflows then start by themselves.

If `update-branch` fails (for example, `main` brought a workflow file change that `GITHUB_TOKEN`
may not push), the run logs a warning and the summary names the PR; the author or steward updates
the branch by hand.
