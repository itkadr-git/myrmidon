## changelog-en

### Unfinished work stays `in_progress` and is resumed two minutes after real progress (1.6.9)

- On 16.11 engineers did one to two minutes of work per run (an edit, tests, a commit, a push to the PR),
  wrote «the task is not ready yet», moved the task `in_progress -> todo` and ended the turn. The
  task was then picked up only by idle pickup after its quiet window, 10-30 minutes on the live
  board: development was idle most of the time.
- Cause: our own text. The execution contract (`packages/adapter-utils/src/server-utils.ts`, both
  wordings) and the default `AGENTS.md` template allowed `in_progress` «only when a live continuation
  path exists», and the agent sees no such path, although the board has one (the in-progress wake,
  OPE-13202).
- Text: the contract and the template now say that an executor whose work is not finished leaves the
  task `in_progress` (the board resumes it by itself, and this is the live continuation path), that
  `todo` returns the task to the queue and is set only when the agent stops working on it, and that
  the agent does not end the turn after the first piece of work if it can continue in the same turn, and that an agent with no next step of its own (waiting for a
  person, access or a decision) sets `blocked` with an unblock owner, not `in_progress`. The first push on a task is followed at once by a draft PR
  (the board's GitHub App is not subscribed to `push`: a branch without a PR is invisible to the
  board and the task is frozen as an empty run); later pushes go into that PR; a finished task gets
  `gh pr ready` and `in_review` with a reviewer.
- Board: for a task in `in_progress` whose executor's last run ended `advanced` and left real
  progress (the PR head moved inside the run's window) the in-progress wake fires after 2 minutes (`CONTINUATION_AFTER_PROGRESS_MINUTES`)
  instead of `runPriority.inProgressIdleWakeMinutes` (20). Without progress the window is the
  previous one. A comment, a document, a (re)registered work product or a status move is not progress,
  so an agent that updates its worklog every run is not woken every 2 minutes. A task judged "no
  progress" is not read again by the short check until the full window ends (in-memory, no queries). Every other guard stays: CI of the
  head in progress, the runs-without-commit cap, blockers and holds, the wake admission, the
  rewake throttle, and the strict release focus (a task outside it is not woken).
- Handoff check: `decideSuccessfulRunHandoff` (`successful-run-handoff.ts`) no longer asks for a
  disposition ("needs a disposition", `finish_successful_run_handoff`) after an `advanced` run that
  left the task `in_progress` with its agent assigned while the in-progress wake is on
  (`inProgressIdleWakeMinutes` > 0): that is a valid disposition, the board continues the task. With
  the wake off, a run that is not `advanced`, or another assignee, the check works as before.
- No migration, no new setting. `docs/myrmidon/SETTINGS.md` is unchanged: the 2-minute pause is a
  constant, `inProgressIdleWakeMinutes = 0` still switches the whole wake off.
- Operator note: the `AGENTS.md` of agents created earlier is a copy of the old template and does
  not change by itself; the board's wake works for them regardless of the text.

## changelog-ru

### Недоделанная работа остаётся `in_progress` и продолжается через две минуты после реального прогресса (1.6.9)

- 16.11 инженеры делали за прогон одну-две минуты работы (правка, тесты, коммит, пуш в PR), писали
  «задача пока не готова», переводили задачу `in_progress -> todo` и заканчивали ход. Дальше задачу
  подбирал только idle pickup после окна тишины, на бою 10-30 минут: разработка простаивала
  большую часть времени.
- Причина: наш собственный текст. Контракт исполнения (`packages/adapter-utils/src/server-utils.ts`,
  обе формулировки) и шаблон `AGENTS.md` разрешали `in_progress` «только при живом пути
  продолжения», а агент такого пути не видит, хотя у доски он есть (побудка задачи в работе,
  OPE-13202).
- Текст: контракт и шаблон теперь говорят, что исполнитель с недоделанной работой оставляет задачу
  `in_progress` (доска продолжит её сама, это и есть живой путь продолжения), что `todo` возвращает
  задачу в очередь и ставится, только когда агент перестаёт ею заниматься, и что не нужно
  заканчивать ход после первого куска, если можно продолжать в этом же ходе, а агент без собственного следующего шага (ждёт человека,
  доступ, решение) ставит `blocked` с владельцем снятия, а не `in_progress`. После первого
  пуша по задаче сразу открывается draft-PR (GitHub-приложение доски не подписано на `push`: ветка
  без PR для доски невидима, и задача замораживается как пустой прогон), дальше пуши идут в этот PR,
  по завершении — `gh pr ready` и `in_review` с ревьюером.
- Доска: для задачи в `in_progress`, у которой последний прогон исполнителя закончился `advanced` и
  дал реальный прогресс (голова PR сменилась в окне прогона), побудка задачи в работе срабатывает через 2 минуты
  (`CONTINUATION_AFTER_PROGRESS_MINUTES`), а не через `runPriority.inProgressIdleWakeMinutes` (20).
  Без прогресса окно прежнее. Комментарий, документ, (пере)регистрация work product или смена статуса прогрессом не считаются, поэтому агент,
  обновляющий worklog каждый прогон, не получает побудку раз в 2 минуты. Задача с решением «прогресса
  нет» короткой проверкой до конца полного окна не читается (в памяти, без запросов). Все
  остальные защиты сохраняются: идущий CI головы, предел прогонов без коммита, блокеры и удержания,
  допуск побудок, тормоз повторных побудок и строгий фокус выпуска (задача вне фокуса не будится).
- Проверка передачи: `decideSuccessfulRunHandoff` (`successful-run-handoff.ts`) больше не требует
  disposition («needs a disposition», `finish_successful_run_handoff`) после прогона `advanced`,
  оставившего задачу `in_progress` у своего агента, пока включена побудка задачи в работе
  (`inProgressIdleWakeMinutes` > 0): это допустимый итог, доска продолжит задачу. При выключенной
  побудке, прогоне не `advanced` или другом исполнителе проверка работает как раньше.
- Без миграций и без новой настройки. `docs/myrmidon/SETTINGS.md` не меняется: пауза в 2 минуты
  зашита константой, `inProgressIdleWakeMinutes = 0` по-прежнему выключает всю побудку.
- Примечание оператору: `AGENTS.md` у ранее созданных агентов — копия старого шаблона и сама не
  меняется; побудка доски для них работает независимо от текста.
