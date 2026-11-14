## changelog-en

### A label-only CI run now publishes `CI result` by mirroring the real run, so approved PRs are no longer stuck as BLOCKED (OPE-13136)

- Since 12.11 (OPE-12841) a `labeled` run for any label other than `full-ci` published no `CI result` check. The board adds
  `review-approved` after a review, which started such a run on the same head, and GitHub then treated the required
  `CI result` as "expected" even though the real run was green. The board's merge was refused and PRs stayed
  `mergeStateStatus=BLOCKED` (board auto-merges fell from 14 to 1 per day).
- The new job `ci-result-label-mirror` publishes `CI result` on that label-only run. It finds the latest real run of the
  workflow on the same head (label-only runs and its own run are ignored), waits up to 120 minutes while that run is
  queued or in progress, and passes only when the real run succeeded and its own `CI result` is `success`. A failed,
  cancelled, skipped or missing real result fails the mirror, so a pass is never published without a real green run.
- Real runs are unchanged: the `ci-result` job keeps its name, `needs` and condition, and the mirror job is skipped under a
  different name, so no skipped `CI result` check is created.

## changelog-ru

### Прогон CI только по метке теперь публикует `CI result`, повторяя результат настоящего прогона, и одобренные PR не застревают в BLOCKED (OPE-13136)

- С 12.11 (OPE-12841) прогон по событию `labeled` с любой меткой, кроме `full-ci`, не публиковал проверку `CI result`.
  Доска ставит `review-approved` после ревью, это запускало такой прогон на той же голове, и GitHub считал обязательную
  `CI result` «ожидаемой», хотя настоящий прогон был зелёным. Слияние от доски отклонялось, PR оставались
  `mergeStateStatus=BLOCKED` (автослияния доски упали с 14 до 1 в сутки).
- Новая задача `ci-result-label-mirror` публикует `CI result` в таком прогоне. Она находит последний настоящий прогон
  workflow на той же голове (прогоны только по метке и свой собственный пропускаются), ждёт до 120 минут, пока он в
  очереди или идёт, и проходит только если настоящий прогон завершился успешно и его собственный `CI result` равен
  `success`. Упавший, отменённый, пропущенный или отсутствующий настоящий результат роняет зеркало, поэтому зелёный
  результат никогда не публикуется без настоящего зелёного прогона.
- Настоящие прогоны не изменились: задача `ci-result` сохраняет имя, `needs` и условие, а зеркало пропускается под другим
  именем, так что проверка `CI result` со статусом skipped не создаётся.
