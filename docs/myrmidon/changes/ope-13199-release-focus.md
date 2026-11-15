## settings-en-new

<!-- after: Track 1 — platform -->

### Release focus for wake admission

The effective instance `runPriority.currentRelease` comes from stored run-priority settings, falling back to `MYRMIDON_CURRENT_RELEASE` (unset means no focus). The focus is active only while `runPriority.strictReleaseFocus` is on (the default) and a current release is set. Labels are compared case-insensitively after trimming, and only an exact match counts (`1.6.90` does not match `1.6.9`). The gate uses labels, not workspace branches.

While the company has an open, visible task with the current-release label (blocked and in-review tasks count), a run for a task that does not carry it is not started and not cancelled: it waits in `scheduled_retry` and is looked at again after 2, 5, 10 and then every 30 minutes, with no new wake made. The run gets one event with reason `release_focus` (once per run). It starts when `strictReleaseFocus` is turned off or the last open task of the current release is closed; after the focus is lifted, a parked run starts at its next look, up to 30 minutes later. A blocked current-release task still holds focus; resolve its blocker or close it as appropriate.

Exceptions: a task the board owner assigned (the latest assignment record is by a board user and names the agent, with no later swarm claim; an old assignment without such a record does not count and must be made again), a review the agent is the current participant of, a wake made by a user (manual wake), and a run without a task. Swarm matching and idle pickup use the same predicate and leave out tasks of other releases. Runs already running are not stopped.

For operator troubleshooting and examples see [Tasks and the board](../wiki/Tasks-and-the-board.md#release-focus-and-wake-diagnostics).

## settings-ru-new

<!-- after: Трек 1 — платформа -->

### Фокус выпуска при допуске побудок

Действующее `runPriority.currentRelease` берётся из сохранённых настроек приоритета экземпляра, иначе из `MYRMIDON_CURRENT_RELEASE`; без значения фокус выключен. Фокус действует, только пока включён `runPriority.strictReleaseFocus` (по умолчанию включён) и задан текущий выпуск. Метки сравниваются без учёта регистра и крайних пробелов, считается только точное совпадение (`1.6.90` не совпадает с `1.6.9`). Гейт смотрит на метки, а не на ветки рабочих копий.

Пока в компании есть открытая видимая задача с меткой текущего выпуска (заблокированные и находящиеся на ревью задачи считаются), прогон по задаче без этой метки не запускается и не отменяется: он ждёт в `scheduled_retry` и пересматривается через 2, 5, 10 минут, а дальше каждые 30, новые побудки не создаются. У прогона одно событие с причиной `release_focus` (один раз на прогон). Он стартует, когда `strictReleaseFocus` выключен или закрыта последняя открытая задача текущего выпуска; после снятия фокуса ожидающий прогон стартует при следующем пересмотре, до 30 минут спустя. Заблокированная задача текущего выпуска удерживает фокус: устраните блокер или закройте задачу, если это уместно.

Исключения: задача, назначенная владельцем доски (последняя запись о назначении сделана пользователем доски и называет агента, позднего захвата роем нет; старое назначение без такой записи не считается и должно быть сделано заново), ревью, в котором агент — текущий участник, побудка, сделанная пользователем (ручная), и прогон без задачи. Матчер роя и idle pickup используют тот же предикат и пропускают задачи других выпусков. Уже идущие прогоны не останавливаются.

Диагностика описана на [странице задач](../wiki/Tasks-and-the-board.ru.md#фокус-выпуска-и-диагностика-побудок).
