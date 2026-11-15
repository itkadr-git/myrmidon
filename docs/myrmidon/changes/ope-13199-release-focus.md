## settings-en-new

<!-- after: Track 1 — platform -->

### Release focus for wake admission

Wake admission and task binding use the effective `runPriority.currentRelease` (stored instance settings take precedence over `MYRMIDON_CURRENT_RELEASE`; unset defaults to no release focus). This is separate from the queue scorer's release bonus. The wake gate compares issue labels, not branch names: matching is case-insensitive after trimming, with equality or containment in either direction; containment requires both strings to be at least three characters.

When an agent has an assigned current-release issue in `todo`, `in_progress`, `in_review` or `blocked`, an automatic wake with an issue ID whose labels do not match is recorded as `skipped` with reason `release_focus`, rather than enqueued. The receipt payload includes `releaseFocus.currentRelease` and `releaseFocus.reason = open_current_release_issue`. A matching wake, or a wake when no such issue exists, passes this gate; other admission checks still apply. An authenticated manual user wake bypasses this gate. A blocked release issue still holds the focus: resolve its blocker rather than expecting another release to run automatically.

The task-binding helper `findTopReadyIssueForAgent` restricts its candidates to that release before normal readiness and priority checks; if none is ready it can return no task. The separate swarm matcher and `idlePickupForAgent` selection algorithm are unchanged; their issue-bound wakes still pass through wake admission. Already queued runs are not retroactively cancelled. For operator troubleshooting and examples see [Tasks and the board](../wiki/Tasks-and-the-board.md#release-focus-and-wake-diagnostics).

## settings-ru-new

<!-- after: Трек 1 — платформа -->

### Фокус выпуска при допуске побудок

Допуск побудок и привязка задачи используют действующее `runPriority.currentRelease`: сохранённая настройка экземпляра важнее `MYRMIDON_CURRENT_RELEASE`; без значения фокус выключен. Это отдельное правило от бонуса выпуска в оценке очереди. Гейт побудки сравнивает метки задач, не имена веток: без учёта регистра и крайних пробелов; совпадение точное либо одна строка содержит другую, причём для включения обе строки должны быть длиной не менее трёх символов.

Если у агента есть назначенная задача текущего выпуска в `todo`, `in_progress`, `in_review` или `blocked`, автоматическая побудка с ID задачи без подходящей метки не ставится в очередь: квитанция получает `skipped` и причину `release_focus`, а payload содержит `releaseFocus.currentRelease` и `releaseFocus.reason = open_current_release_issue`. Побудка подходящей задачи или побудка при отсутствии таких назначений проходит этот гейт; остальные проверки допуска сохраняются. Аутентифицированная ручная побудка пользователя обходит именно этот гейт. Заблокированная задача тоже удерживает фокус: устраняйте блокер, а не ждите автоматического запуска другого выпуска.

`findTopReadyIssueForAgent` ограничивает кандидатов текущим выпуском до обычных проверок готовности и приоритета; если готовых нет, задача может не выбираться. Алгоритмы swarm matching и отдельного `idlePickupForAgent` не меняются; их побудки с ID задачи всё равно проходят допуск. Уже поставленные в очередь прогоны задним числом не отменяются. Диагностика описана на [странице задач](../wiki/Tasks-and-the-board.ru.md#фокус-выпуска-и-диагностика-побудок).
