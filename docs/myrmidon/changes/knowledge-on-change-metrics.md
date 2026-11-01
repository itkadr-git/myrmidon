---
settings-section: 1.6.6 — KNOWLEDGE-ON-CHANGE: метрики покрытия вики
---

## changelog-en

### Knowledge-on-change telemetry on the metrics scrape

- `GET /metrics` answers two more families: `myrmidon_knowledge_on_change_share` (gauge) and `myrmidon_knowledge_revision_delay_seconds` (summary, quantile 0.5/0.95).
- `myrmidon_knowledge_on_change_share` is the share of tasks closed in the last 7 days that have a merged pull-request work product (a system change) and a knowledge revision citing the task (`knowledge_sources` kind=`task`, ref=`issues.identifier`). Tasks closed without a merged PR stay out of the denominator; tasks closed with a merged PR but without a wiki revision count in the denominator only.
- `myrmidon_knowledge_revision_delay_seconds` is the delay from a merged pull-request work product (`issue_work_products` type=`pull_request`, status=`merged`) to a knowledge revision citing that PR (`knowledge_sources` kind=`pr`, matched by `externalId` or `url`). Both quantiles are linear-interpolated percentiles over the non-negative samples.
- Both families are collected by the existing guarded collector; a failed DB read never kills the scrape and renders HELP/TYPE without samples. `METRIC_FAMILIES` names both families so the selfcheck on a broken DB lists them. Each sample carries the existing `role` label.
- The metrics-scrape-failing runbook documents how to interpret the new families.

## changelog-ru

### Метрики knowledge-on-change в скрейпе метрик

- Эндпоинт `/metrics` публикует два новых семейства: `myrmidon_knowledge_on_change_share` (gauge) и `myrmidon_knowledge_revision_delay_seconds` (summary, квантиль 0.5/0.95).
- `myrmidon_knowledge_on_change_share` — доля задач, закрытых за последние 7 дней, у которых есть слитый pull-request work product (системное изменение) и ревизия вики, ссылающаяся на задачу (`knowledge_sources` kind=`task`, ref=`issues.identifier`). Задачи, закрытые без слитого PR, в знаменатель не входят; задачи со слитым PR, но без ревизии вики входят только в знаменатель.
- `myrmidon_knowledge_revision_delay_seconds` — задержка от слитого pull-request work product (`issue_work_products` type=`pull_request`, status=`merged`) до ревизии вики, ссылающейся на этот PR (`knowledge_sources` kind=`pr`, сопоставление по `externalId` или `url`). Оба квантиля — линейно интерполированные перцентили по неотрицательным выборкам.
- Оба семейства собираются существующим guarded-коллектором; неудачное чтение из БД не роняет скрейп и отдаёт HELP/TYPE без сэмплов. `METRIC_FAMILIES` называет оба семейства, поэтому selfcheck на сломанной БД их перечисляет. Каждый сэмпл несёт существующую метку `role`.
- Runbook `metrics-scrape-failing` описывает интерпретацию новых семейств.
