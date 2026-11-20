---
settings-section: Track 5 — operations
---

## changelog-en

### CI: CI result start latency caused by the runner queue is a warning, not a failure (OPE-13479)

- The `CI result` job checks how long it started after the last predecessor job finished (fail-closed gate, OPE-10065, PR #2063). On 2026-11-16 10:46 (UTC+8) PR #3306, run 43789711787, had all 20 test and build jobs green, but `CI result` failed: `CI result start latency exceeded threshold: 249s > 120s`. The runner queue was full of bot PRs and the job waited for a free runner. A rerun did not help, because the delay only grew.
- The check now splits the delay. The time the `CI result` job spent in `queued` (job `created_at` to `started_at`) is reported as `::warning::` with the numbers (latency, queue wait, runner name). It does not fail the run.
- The check still fails when the part that the runner queue does not explain (last predecessor end to job `created_at`) is more than 120 s, and when timestamps are missing. A job that is stuck after it got a runner is still stopped by `timeout-minutes: 5`.
- The inline bash and jq in `myrmidon-ci.yml` and `myrmidon-ci-tag.yml` moved to `scripts/myrmidon/ci/queue-metrics.mjs --verify-latency`. Tests are in `scripts/myrmidon/ci/queue-metrics.test.mjs` (queue delay 300 s with green jobs gives success and a warning; a delay not caused by the queue gives failure).

## changelog-ru

### CI: задержка старта «CI result» из-за очереди раннеров — предупреждение, а не отказ (OPE-13479)

- Задание `CI result` проверяет, через сколько после завершения последнего предшествующего задания оно стартовало (закрытая проверка, OPE-10065, PR #2063). 16.11.2026 10:46 (UTC+8) в PR #3306, прогон 43789711787, все 20 заданий тестов и сборки были зелёными, а `CI result` упало: `CI result start latency exceeded threshold: 249s > 120s`. Очередь раннеров была забита PR ботов, задание ждало свободный раннер. Перезапуск не помогал: задержка только росла.
- Теперь проверка делит задержку. Время, которое задание `CI result` провело в `queued` (от `created_at` до `started_at` самого задания), выводится как `::warning::` с цифрами (задержка, ожидание в очереди, имя раннера) и итог не краснит.
- Проверка по-прежнему падает, если часть задержки, не объяснённая очередью раннеров (от конца последнего предшественника до `created_at` задания), больше 120 с, и если нет временных меток. Задание, зависшее после получения раннера, по-прежнему останавливает `timeout-minutes: 5`.
- Встроенные bash и jq из `myrmidon-ci.yml` и `myrmidon-ci-tag.yml` вынесены в `scripts/myrmidon/ci/queue-metrics.mjs --verify-latency`. Тесты — в `scripts/myrmidon/ci/queue-metrics.test.mjs` (задержка очереди 300 с при зелёных заданиях — успех с предупреждением; задержка не из-за очереди — отказ).
