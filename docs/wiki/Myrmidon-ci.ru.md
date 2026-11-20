# CI Myrmidon

> English version: [Myrmidon-ci](Myrmidon-ci)

Для чернового PR события `opened`, `reopened` и `synchronize` пропускают тяжёлые задания Myrmidon CI, включая планирование, сборку, тесты и проверки. Перевод PR в ready создаёт событие `ready_for_review` и запускает обычный CI на текущей голове. Пропущенный итог draft называется `draft CI omitted`, а не `CI result`: отсутствие `CI result` не означает зелёный merge gate. Для ready PR нужен настоящий вердикт обязательной проверки `CI result`.

Для ручного запуска откройте Actions → Myrmidon CI → Run workflow и укажите непустую причину `reason`, не состоящую только из пробелов. Job `plan` записывает её в summary GitHub Actions; пустая причина приводит к ошибке планирования. Ручной запуск проходит полный уровень.

Push в `main` и проверки `merge_group` по-прежнему проходят полный уровень. Для релизных тегов используется отдельный workflow, который этот гейт не меняет. Подробности: [руководство CI](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/ci.md) и [workflow](https://github.com/itkadr-git/myrmidon/blob/main/.github/workflows/myrmidon-ci.yml).

## Журнал изменений

20.11.2026 — Тяжёлый CI для draft PR откладывается до ready; ручной запуск требует записанную причину. OPE-15275, PR #4624.
