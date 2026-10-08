## changelog-en

### Auto-update of auto-merge PRs without a GitHub merge queue (PR-AUTOUPDATE)

- `.github/workflows/myrmidon-pr-autoupdate.yml` — on every push to `main` (and
  every 30 minutes, and by hand) merges `main` into the oldest open PR that has
  auto-merge on and is behind `main`, then dispatches CI and `hot-files-review`
  on the new head. PRs in conflict get the `needs-rebase` label and a comment.
- `myrmidon-hot-files-review.yml` accepts `workflow_dispatch` with the PR number.
- The `main-protection` ruleset requires PRs to be up to date before merge.

## changelog-ru

### Автообновление PR с автослиянием без очереди GitHub (PR-AUTOUPDATE)

- `.github/workflows/myrmidon-pr-autoupdate.yml` — на каждый push в `main` (а также
  раз в 30 минут и вручную) вливает `main` в самый старый открытый PR с включённым
  автослиянием, который отстал от `main`, и запускает CI и `hot-files-review` на
  новой голове. PR с конфликтом получают метку `needs-rebase` и комментарий.
- `myrmidon-hot-files-review.yml` принимает `workflow_dispatch` с номером PR.
- Ruleset `main-protection` требует актуальности ветки PR перед слиянием.
