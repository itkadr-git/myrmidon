## changelog-en

### A label other than `full-ci` no longer leaves the required CI result check expected (CI-LABEL-NOOP-KEEPS-RESULT)

- `Myrmidon CI` no longer runs on the `labeled` event. The `review-approved`
  label (and `review-in-progress`, `needs-rebase`, ...) used to start a run
  that became the newest run on the PR head with no `CI result` in it; GitHub
  then treated the required `CI result` as "expected" although the real run
  was green, and the merge (auto-merge and the board bot) was refused.
  Now such a label creates no run and the verdict of the last real run stays.
- The `full-ci` label is handled by the new `myrmidon-ci-full-label.yml`: it
  cancels the running `Myrmidon CI` run on the head and re-runs it as a full
  run (`scripts/myrmidon/ci/rerun-full-ci.mjs`). The `plan` step reads the PR
  labels live (an API failure in a re-run fails the step instead of using the
  stale payload), because a re-run keeps the old event payload. The script is
  taken from the PR base commit; the re-run is retried after a cancel and is
  skipped when the head moved; the hot files check does not drop
  `review-approved` in a re-run.
- The OPE-12841 protection is kept by construction: no label run exists that
  could publish a passing `CI result` on a head without a green real run.

## changelog-ru

### Метка, отличная от `full-ci`, больше не оставляет обязательную проверку CI result «ожидаемой» (CI-LABEL-NOOP-KEEPS-RESULT)

- `Myrmidon CI` больше не запускается на событие `labeled`. Метка
  `review-approved` (и `review-in-progress`, `needs-rebase`, ...) раньше
  запускала прогон, который становился самым новым на голове PR и не содержал
  `CI result`; GitHub считал обязательную `CI result` «ожидаемой», хотя
  настоящий прогон зелёный, и слияние (авто-слияние и бот доски) отклонялось.
  Теперь такая метка не создаёт прогона, и остаётся итог последнего настоящего
  прогона.
- Метку `full-ci` обрабатывает новый `myrmidon-ci-full-label.yml`: он отменяет
  идущий прогон `Myrmidon CI` на голове и перезапускает его полным
  (`scripts/myrmidon/ci/rerun-full-ci.mjs`). Шаг `plan` читает метки PR живьём,
  потому что перезапуск сохраняет старую полезную нагрузку события (ошибка API
  при перезапуске валит шаг, а не берёт старые метки). Скрипт берётся с базового
  коммита PR; перезапуск повторяется после отмены и пропускается, если голова
  сдвинулась; проверка горячих файлов в перезапуске не снимает `review-approved`.
- Защита OPE-12841 сохранена по построению: прогона по метке, который мог бы
  опубликовать успешную `CI result` на голове без зелёного настоящего прогона,
  больше нет.
