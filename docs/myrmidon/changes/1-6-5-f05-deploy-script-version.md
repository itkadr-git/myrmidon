## changelog-en

### The deploy journal opens with the version of the deploy scripts (1.6.5 F-05)

- `deploy.sh` and `deploy-from-job.sh` now write `deploy scripts at <git describe --tags --always>` as the first line of the deploy journal (stderr, so it lands in `job-<id>.log` of a deploy started from the UI). When git or the clone is unavailable the line reads `deploy scripts at unknown`; the stamp never aborts a deploy.
- Guard: `scripts/myrmidon/deploy/deploy-hygiene.test.mjs` and `deploy-from-job.test.mjs` cover the first journal line, the failing-git and no-git fallbacks and the job log.

## changelog-ru

### Журнал выката открывается версией скриптов выката (1.6.5 F-05)

- `deploy.sh` и `deploy-from-job.sh` первой строкой журнала выката пишут `deploy scripts at <git describe --tags --always>` (в stderr, поэтому строка попадает в `job-<id>.log` выката из интерфейса). Если git или клон недоступны, строка читается `deploy scripts at unknown`; метка никогда не прерывает выкат.
- Страж: `scripts/myrmidon/deploy/deploy-hygiene.test.mjs` и `deploy-from-job.test.mjs` проверяют первую строку журнала, запасные пути без git / при падении git и журнал задачи.
