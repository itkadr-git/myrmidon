## changelog-en

### Release publish: the tag-CI gate wait budget doubled to 80 min (RELEASE-GATE-POLL-BUDGET)

The publish step of a release tag waits for the tag's own CI run
(`myrmidon-ci-tag.yml`) up to `POLL_SECONDS × POLL_MAX`. A tag push starts
nine workflows at once, and under the hosted-runner queue the rc.13 tag CI
took ~50 minutes while the budget was 20 s × 120 = 40 minutes — the publish
died at the timeout with an empty verdict eleven minutes before the green
run landed, leaving the tag without its GitHub Release (the rc.13 blocker,
the rc.13 publish blocker). The publish job now sets `MYRMIDON_RELEASE_POLL_MAX: "240"`
(20 s × 240 = 80 min, inside the job's 90-minute timeout; the wait still
exits early once the run completes), and a regression test pins the
«the run completes only after more than the old 120 polls» scenario.

## changelog-ru

### Публикация релиза: бюджет ожидания гейта tag-CI удвоен до 80 минут (RELEASE-GATE-POLL-BUDGET)

Шаг publish релизного тега ждёт собственный CI-ран тега
(`myrmidon-ci-tag.yml`) не дольше `POLL_SECONDS × POLL_MAX`. Пуш тега
запускает девять workflow одновременно, и под нагрузкой очереди
hosted-раннеров tag-CI rc.13 шёл ~50 минут при бюджете 20 с × 120 = 40
минут — publish умер по таймауту с пустым вердиктом за одиннадцать минут
до зелёного рана, и тег остался без GitHub Release (блокер rc.13,
the rc.13 publish blocker). Джоба publish теперь задаёт `MYRMIDON_RELEASE_POLL_MAX: "240"`
(20 с × 240 = 80 минут, внутри 90-минутного таймаута джобы; ожидание
по-прежнему завершается сразу, как только ран завершился), а регрессионный
тест фиксирует сценарий «ран появляется только после 120 с лишним
поллов».
