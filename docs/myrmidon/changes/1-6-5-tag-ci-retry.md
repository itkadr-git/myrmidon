---
divergence-section: 1.6 — эксплуатация и релизный цикл
---

## changelog-en

### The publish gate survives transient gh api failures (1.6.5 TAG-CI-RETRY)

- The 1.6.5 rc.13 incident: the tag's CI run finished `success` 50 minutes in,
  but one `gh api` read of the runs list failed transiently (5xx / a
  secondary rate limit while polling every 20 s). The old gate swallowed the
  failure (`|| true`), the jq pipeline then read EMPTY input and answered an
  EMPTY verdict — and `"" != "missing"` read as a COMPLETED run with an empty
  conclusion, killing the publish after 36 minutes with "(conclusion: )"
  while the CI was still green on its way to success.
- `runs_of` now retries the `gh api` read with backoff
  (`MYRMIDON_RELEASE_GH_RETRIES`, default 3; `MYRMIDON_RELEASE_GH_RETRY_SLEEP`,
  default 5 s); a persistent failure answers an empty runs list which every
  caller normalizes to `missing` — the gate keeps WAITING (a retryable
  answer), never a bogus refusal.
- `run_verdict`/`run_status` normalize an empty/blank read to `missing` —
  an empty conclusion can no longer kill the publish.
- The poll budget grew from 120 to 180 polls (40 → 60 minutes): the tag CI
  measured ~50 minutes (18:15 → 19:05), so the old budget would have timed
  out a clean publish even without the API glitch. The publish job's
  `timeout-minutes: 90` still bounds the run.

## changelog-ru

### Гейт публикации переживает транзиентные сбои gh api (1.6.5 TAG-CI-RETRY)

- Инцидент 1.6.5 rc.13: прогон CI тега завершился `success` за 50 минут, но
  один `gh api`-запрос списка прогонов упал транзиентно (5xx / вторичный
  rate limit при поллинге каждые 20 с). Старый гейт глотал сбой (`|| true`),
  jq-конвейер читал ПУСТОЙ вход и отвечал ПУСТЫМ verdict — а `"" != "missing"`
  читалось как ЗАВЕРШЁННЫЙ прогон с пустым conclusion, убивая публикацию
  через 36 минут с "(conclusion: )", пока CI шёл к зелёному завершению.
- `runs_of` теперь повторяет `gh api`-чтение с бэкоффом
  (`MYRMIDON_RELEASE_GH_RETRIES`, по умолчанию 3;
  `MYRMIDON_RELEASE_GH_RETRY_SLEEP`, по умолчанию 5 с); персистентный сбой
  отвечает пустым списком прогонов, который все вызывающие нормализуют в
  `missing` — гейт продолжает ЖДАТЬ (повторяемый ответ), а не отказывать
  ложно.
- `run_verdict`/`run_status` нормализуют пустое чтение в `missing` — пустой
  conclusion больше не может убить публикацию.
- Бюджет поллинга вырос со 120 до 180 попыток (40 → 60 минут): CI тега
  замерян в ~50 минут (18:15 → 19:05), так что старый бюджет уронил бы чистую
  публикацию и без сбоя API. `timeout-minutes: 90` publish-джобы по-прежнему
  ограничивает прогон.
