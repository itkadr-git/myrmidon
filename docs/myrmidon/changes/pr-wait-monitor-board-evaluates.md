## changelog-en

### A monitor that waits for a pull request no longer starts a model run just to look at it (PR-WAIT-MONITOR)

- A due issue monitor whose service name or notes say it waits for CI or a pull request
  (`CI`, `github_actions_ci`, "waiting for CI to finish", ...) is now evaluated by the board
  from rows it already has: the pull request work products (status, review state, the
  `activeCi` / `lastCompletedCi` marks written by GitHub connection events) and the end of the
  agent's last run on the task. No GitHub call is made.
- Nothing new since the agent last looked: the agent stays asleep and the monitor is re-armed
  with a doubling interval (10, 20, 40 minutes, capped at 60); the check is logged as
  `issue.monitor_deferred` with reason `pr_wait_unchanged`. The agent's own `timeoutAt` is
  never postponed.
- News (CI completed, review submitted, merge conflict, pull request merged or closed) wakes
  the agent as before, with the observed change in the wake payload and context
  (`observedChange`, `observedChangeSummary`). When the board holds no CI data for the pull
  request and has seen nothing for 30 minutes, the agent is woken once with a `no_signal`
  note, so a finished CI is never left unnoticed.
- A run woken by a monitor no longer re-arms the "GitHub CI pending monitor" from its own
  context: that context carries the monitor's note ("CI pending"), which the successful-run
  handoff read as proof that CI was still pending, so the monitor re-armed itself after every
  run (one task reached 57 attempts). The agent's last comment and the recorded CI marks
  still count.
- A due monitor on a task that is no longer an active agent task (backlog, todo, done,
  cancelled, or not assigned to an agent) is cleared instead of left armed.
- A person triggering a monitor by hand, review-recovery monitors and monitors that do not
  wait for a pull request behave as before.

## changelog-ru

### Монитор ожидания pull request больше не запускает прогон модели только ради взгляда на него (PR-WAIT-MONITOR)

- Наступивший монитор задачи, у которого в названии сервиса или заметке сказано, что он ждёт
  CI или pull request (`CI`, `github_actions_ci`, «жду завершения CI» и т. п.), теперь
  оценивает сама доска по уже имеющимся строкам: рабочие продукты pull request (статус,
  состояние ревью, отметки `activeCi` / `lastCompletedCi` от событий подключения GitHub) и
  время окончания последнего прогона агента по задаче. Вызовов GitHub нет.
- Если с последнего взгляда агента ничего не изменилось, агент спит, а монитор переставляется
  с удваивающимся интервалом (10, 20, 40 минут, потолок 60); проверка пишется как
  `issue.monitor_deferred` с причиной `pr_wait_unchanged`. Собственный `timeoutAt` агента
  не сдвигается.
- Новость (CI завершился, ревью отправлено, конфликт слияния, pull request влит или закрыт)
  будит агента как раньше, с замеченным изменением в нагрузке и контексте побудки
  (`observedChange`, `observedChangeSummary`). Если у доски нет данных о CI этого pull request
  и 30 минут ничего не менялось, агент будится один раз с пометкой `no_signal`, чтобы
  завершённый CI не остался незамеченным.
- Прогон, разбуженный монитором, больше не взводит «GitHub CI pending monitor» заново по
  собственному контексту: в нём лежит заметка самого монитора («CI pending»), и передача
  после успешного прогона принимала её за доказательство, что CI ещё идёт, — монитор
  взводил сам себя после каждого прогона (у одной задачи дошло до 57 попыток). Последний
  комментарий агента и записанные отметки CI по-прежнему учитываются.
- Наступивший монитор задачи, которая уже не активная задача агента (backlog, todo, done,
  cancelled или не назначена агенту), снимается, а не остаётся взведённым.
- Ручной запуск монитора человеком, мониторы восстановления ревью и мониторы, не ждущие pull
  request, работают как раньше.
