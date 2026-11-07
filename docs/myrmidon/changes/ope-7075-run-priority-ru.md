---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## settings-ru

| `MYRMIDON_RUN_PRIORITY_ENABLED` | 1.6.5 RUN-PRIORITY | `on` | Главный переключатель ядра приоритета очереди прогонов. При выключении оба прохода сохраняют прежний порядок. `0`, `off`, `false` выключают приоритет; остальные значения и отсутствие оставляют его включённым. Хранится в `instance_settings.general.runPriority.enabled`; изменение через `PATCH /api/myrmidon/run-priority` применяется без перезапуска | отсутствие — включён |
| `MYRMIDON_RUN_PRIORITY_ROLE_WEIGHTS` | 1.6.5 RUN-PRIORITY | `review=90,release=90,lead=80,engineer=50,docs=50` | Вес роли агента (`agents.role`, без учёта регистра). Пары `role=weight` разделяются запятыми; неизвестная роль получает вес по умолчанию. Значения хранятся в `general.runPriority.roleWeights` | некорректная пара пропускается; отрицательные и нечисловые веса возвращают карту по умолчанию; диапазон — целые числа 0..1000 |
| `MYRMIDON_RUN_PRIORITY_DEFAULT_ROLE_WEIGHT` | 1.6.5 RUN-PRIORITY | `30` | Вес роли, которой нет в карте ролей, включая встроенную `general`. Хранится в `general.runPriority.defaultRoleWeight` | нецелое значение или число вне 0..1000 — значение по умолчанию |
| `MYRMIDON_RUN_PRIORITY_ISSUE_WEIGHTS` | 1.6.5 RUN-PRIORITY | `critical=100,high=80,medium=60,low=40,none=20` | Вес приоритета задачи (`issues.priority`). Ключ `none` покрывает неизвестный или отсутствующий приоритет; приоритет задачи упорядочивает прогоны только внутри полосы роли | некорректная запись пропускается; для сохранения карты нужен ключ `none` |
| `MYRMIDON_CURRENT_RELEASE` | 1.6.5 RUN-PRIORITY | не задано (выключено) | Тег текущего релиза, например `1.6.5-rc.6`. Ожидающий прогон, у задачи которого есть метка с этим тегом или ветка рабочего пространства содержит его, поднимается на одну полосу выше самой тяжёлой роли; надбавка `releaseBonus` добавляется поверх полосы, поэтому такой прогон стартует раньше прогонов любой роли независимо от приоритета задачи. Сопоставление — по вхождению подстроки в любую сторону, без учёта регистра; кандидаты короче 3 символов не совпадают. Хранится в `general.runPriority.currentRelease` | не задано, пусто или `null` — надбавка текущего релиза выключена |
| `MYRMIDON_RUN_RELEASE_BONUS` | 1.6.5 RUN-PRIORITY | `20` | Надбавка к полосе прогона, совпавшего с текущим релизом | нецелое значение или число вне 0..1000 — значение по умолчанию |
| `MYRMIDON_RUN_AGING_STEP_MIN` / `MYRMIDON_RUN_AGING_STEP_WEIGHT` / `MYRMIDON_RUN_AGING_MAX_BONUS` | 1.6.5 RUN-PRIORITY | `10` / `5` / `50` | За каждые заданные минуты ожидания в `queued` эффективный вес растёт на заданный шаг, но не выше максимальной надбавки. Aging действует внутри полосы роли и не переносит прогон в чужую полосу | шаг минут или шаг веса `0` — aging выключен; недопустимые значения заменяются значениями по умолчанию |
| `MYRMIDON_RUN_STARVATION_LIMIT_MIN` / `MYRMIDON_RUN_STARVATION_TOP_WEIGHT` | 1.6.5 RUN-PRIORITY | `90` / `10000` | Защита от голодания: после указанного времени ожидания прогон получает верхний вес и может обойти полосы ролей и текущего релиза | лимит `0` — побег от голодания выключен, решение принимает только aging |

## changelog-en

### Run queue position and wait reason in the run card (RUN-PRIORITY)

A queued run card shows its queue position and why it is waiting, such as a higher-priority run or a per-agent concurrency limit. The queue position and wait reason are provided by the run queue API and displayed alongside the run state.

## changelog-ru

### Позиция в очереди и причина ожидания в карточке прогона (RUN-PRIORITY)

В карточке ожидающего прогона отображаются его позиция в очереди и причина ожидания — например, наличие прогона с более высоким приоритетом или лимит одновременных прогонов для агента. Эти сведения предоставляет API очереди прогонов; они показаны рядом с состоянием прогона.
