---
settings-section: Track 5 — operations
---

## changelog-en

### CI-QUEUE: cancel-in-progress concurrency for workflows running on main (1.6.7)

- Workflows triggering on push to `main` (image, bot image, cloud files, dockergate, extension, fleetd, media tools, redact, wiki-sync, pr-autoupdate, agent-runtime-images, extension-package) and workflow_run `main` trigger (main green gate) now configure `concurrency` with `cancel-in-progress: true` when running on `main`.
- Release branches (`rel/*`) and release tags (`myr-v*`) remain protected from cancellation (`cancel-in-progress: false`).
- Added `scripts/myrmidon/ci/check-workflow-concurrency.py` and unit test `scripts/myrmidon/ci/workflow-concurrency.test.mjs` verifying that all workflows triggering on `main` specify concurrency cancellation for `main`.

## changelog-ru

### CI-QUEUE: отмена устаревших прогонов workflow на main (1.6.7)

- В workflow, запускаемых на push в `main` (сборки образов image, bot-image, cloud files, dockergate, extension, fleetd, media tools, redact, wiki-sync, pr-autoupdate, agent-runtime-images, extension-package) и workflow_run на main (`main green gate`), настроена группа `concurrency` с `cancel-in-progress: true` для `main`.
- Релизные ветки (`rel/*`) и теги релизов (`myr-v*`) защищены от отмены (`cancel-in-progress: false`).
- Добавлен проверочный скрипт `scripts/myrmidon/ci/check-workflow-concurrency.py` и тест `scripts/myrmidon/ci/workflow-concurrency.test.mjs`, валидирующий наличие `concurrency` у всех workflow, запускающихся на `main`.
