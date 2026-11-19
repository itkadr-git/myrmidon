## changelog-en

### A monitor that waits for a review or a merge no longer wakes its agent every 30 minutes (EMPTY-RUNS-4)

- A due issue monitor that waits for a pull request is judged by the board (PR-WAIT-MONITOR, OPE-11949). When nothing was news it had two states: CI is running, or the board holds no check data — and the second one wakes the agent with a `no_signal` note after 30 quiet minutes. A pull request whose CI had finished, with the result already seen by the agent, fell into that second state as well. So every "wait for the merge" monitor woke its agent each time it came due, only to answer "still open": 32 such `no_signal` runs of engineers in 19 hours on the release board, one task at its 36th monitor attempt and another at its 59th.
- That state is now told apart as `settled`: CI of the current head finished, the agent has seen it, nothing is running. The monitor re-arms silently (`issue.monitor_deferred`, reason `pr_wait_unchanged`, `ciState: "settled"`) with the same growing interval, capped at 60 minutes.
- The agent is still woken at once for news the board records — the pull request was merged or closed, a review was submitted, a merge conflict appeared, CI completed again — at its own `timeoutAt` / `maxAttempts`, and after 6 quiet hours as the last backstop, with a note that names the finished CI.
- Several work product rows of one pull request (the ones an agent registered and the one the board linked from the GitHub event) are judged as one pull request, by the row that carries the finished CI of its head. A second pull request of the task without check data keeps the whole wait in the old 30-minute state.
- Unchanged: a pull request the board holds no check data for is still woken after 30 minutes; a monitor that does not wait for a pull request is not touched.

## changelog-ru

### Монитор, который ждёт ревью или слияния, больше не будит агента каждые 30 минут (EMPTY-RUNS-4)

- Сработавший монитор задачи, который ждёт pull request, оценивает сама доска (PR-WAIT-MONITOR, OPE-11949). Если новостей нет, состояний было два: CI идёт или у доски нет данных о проверках — и во втором агент через 30 тихих минут будится с пометкой `no_signal`. Pull request, у которого CI уже завершился и агент этот результат видел, попадал туда же. Поэтому каждый монитор «жду слияния» будил агента при каждом срабатывании ради ответа «всё ещё открыт»: 32 таких прогона инженеров за 19 часов на доске выпуска, у одной задачи 36-я попытка монитора, у другой 59-я.
- Теперь это отдельное состояние `settled`: CI текущей головы завершён, агент его видел, ничего не выполняется. Монитор перевзводится молча (`issue.monitor_deferred`, причина `pr_wait_unchanged`, `ciState: "settled"`) с тем же растущим интервалом, не больше 60 минут.
- Агент по-прежнему будится сразу на новость, которую записала доска, — pull request слит или закрыт, подано ревью, появился конфликт слияния, CI завершился ещё раз, — по собственному сроку `timeoutAt` / `maxAttempts`, а также после 6 тихих часов как последняя страховка, с пометкой, в которой назван завершённый CI.
- Несколько строк work product одного pull request (те, что зарегистрировал агент, и та, что доска привязала по событию GitHub) оцениваются как один pull request — по строке, в которой записан завершённый CI её головы. Второй pull request задачи без данных о проверках оставляет всё ожидание в прежнем 30-минутном состоянии.
- Без изменений: pull request, о проверках которого у доски нет данных, по-прежнему будит агента через 30 минут; монитор, который ждёт не pull request, не затронут.
