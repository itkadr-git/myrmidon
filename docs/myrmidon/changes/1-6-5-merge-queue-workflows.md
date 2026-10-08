## changelog-en

### Merge queue: CI checks the candidate commit on top of fresh main (MERGE-QUEUE)

- `.github/workflows/myrmidon-ci.yml` and `myrmidon-hot-files-review.yml` gained the
  `merge_group: types: [checks_requested]` trigger. `plan` and `tests-affected` diff
  `merge_group.base_sha..head_sha` — the PR's own diff on top of the fresh main — so
  `plan`, `typecheck`, `build`, `tests-affected` and `ci-result` run on the queue candidate
  exactly as they do on the PR, and the `main-protection` ruleset requirements hold.
- A `merge_group` CI run is never auto-cancelled (`cancel-in-progress` off for that event):
  a cancelled run would evict the group from the queue.
- For `merge_group`, `hot-files-review` only reports success on the candidate: review is
  enforced on the PR via the `review-approved` label, the queue must not block on it.
- New guide `docs/myrmidon/merge-queue.md` (en; [русский](merge-queue.ru.md)): the queue
  process, reviewer/steward roles, `gh pr merge --auto`, what to do when a PR leaves the
  queue; the guide is listed in `docs/myrmidon/README.md`.

## changelog-ru

### Очередь слияний: CI проверяет кандидата поверх свежего main (MERGE-QUEUE)

- В `.github/workflows/myrmidon-ci.yml` и `myrmidon-hot-files-review.yml` добавлен триггер
  `merge_group: types: [checks_requested]`. `plan` и `tests-affected` считают diff
  `merge_group.base_sha..head_sha` — diff PR поверх свежего main, — поэтому `plan`,
  `typecheck`, `build`, `tests-affected` и `ci-result` идут на кандидате очереди так же,
  как на PR, и требования ruleset `main-protection` выполняются.
- Прогон CI на `merge_group` не отменяется автоматически (`cancel-in-progress` выключен для
  этого события): отменённый прогон выкидывает группу из очереди.
- На `merge_group` джоб `hot-files-review` только выставляет success на кандидате: ревью
  обеспечивается на PR меткой `review-approved`, очередь блокировать нечем.
- Добавлено руководство `docs/myrmidon/merge-queue.md` (en; [русский](merge-queue.ru.md)):
  процесс очереди, роли ревьюера и стюарда, `gh pr merge --auto`, действия при выпадении PR
  из очереди; руководство добавлено в `docs/myrmidon/README.md`.
