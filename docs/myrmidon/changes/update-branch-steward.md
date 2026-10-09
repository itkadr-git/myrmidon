## changelog-en

### Merge steward refreshes the head with update-branch and waits for green CI (UPDATE-BRANCH-STEWARD)

- The review-routing merge steward lands approved PRs in the open. When the
  sweep sees an APPROVED green head, the steward task it creates carries an
  explicit three-step landing path: `gh pr update-branch <repo>#<n>` (GitHub's
  `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` — a no-op when
  the branch is already current), then waiting for the refreshed head to go
  green, then `gh pr merge <repo>#<n> --merge`.
- The wait is enforced by the lane's own head rules, not by new code: the
  update-branch push moves the PR head, so the review verdict must be
  re-checked on the new head (the resolver filters reviews by the current head
  sha), and the old steward task is superseded and cancelled the moment the
  recorded head stops matching. The sweep creates a fresh steward task for the
  new head only when it turns green with APPROVED on it — which is precisely
  "wait for green CI on the updated branch, then merge".
- The freshness guarantee lives in the open: the `main-protection` ruleset
  runs with strict required status checks and GitHub refuses to merge a PR
  whose branch is behind its base, so update-branch before the merge is what
  keeps the landing head — and after it main — green. The refresh works on any
  repository, including `itkadr-git/myrmidon` (a personal account, where
  platform-side ordering features do not exist).
- No settings changed and no new environment variables: the merge-steward
  block (`prWatch.steward`) keeps its shape; only the action the created
  steward task instructs changed.

## changelog-ru

### Хранитель слияний обновляет голову через update-branch и ждёт зелёный CI (UPDATE-BRANCH-STEWARD)

- Merge-steward review-routing приземляет одобренные PR открыто. Увидев
  APPROVED-зелёную голову, sweep создаёт задачу хранителя с явным трёхшаговым
  путём: `gh pr update-branch <repo>#<n>` (это
  `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` — no-op, если
  ветка уже актуальна), затем ожидание зелёного CI на обновлённой голове,
  затем `gh pr merge <repo>#<n> --merge`.
- Ожидание обеспечивают собственные правила дорожки, а не новый код: пуш
  update-branch сдвигает голову PR, поэтому вердикт ревью перечитывается на
  новой голове (резолвер фильтрует ревью по актуальному sha головы), а старая
  задача хранителя снимается и отменяется, как только записанная голова
  перестаёт совпадать. Sweep создаст новую задачу хранителя только когда новая
  голова станет зелёной с APPROVED на ней — ровно «ждать зелёный CI на
  обновлённой ветке, затем мержить».
- Гарантия свежести лежит на поверхности: ruleset `main-protection` со strict
  required status checks, GitHub не мержит PR с веткой, отставшей от базы, —
  поэтому именно update-branch перед слиянием оставляет зелёной и голову
  слияния, и main после него. Механизм работает в любом репозитории, включая
  `itkadr-git/myrmidon` (личный аккаунт, где платформенные механизмы
  упорядоченного слияния не существуют).
- Настройки не менялись, новых переменных окружения нет: блок хранителя
  (`prWatch.steward`) сохраняет форму — изменилось только действие, которое
  предписывает созданная задача.
