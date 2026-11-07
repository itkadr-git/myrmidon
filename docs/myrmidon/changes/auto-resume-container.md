## changelog-en

### An agent in "контейнер не поднят" gets its bot container started automatically (1.6.6 AUTO-RESUME)

- When the gateway connect retries of a run ran out, the board marks the agent
  `error` with the reason "контейнер не поднят". Auto-resume used to skip that
  reason (`container_not_started`) until an operator started the container; on
  07.11 an idle-stopped container left adm-devops in error for 4.5 hours.
- The sweep now starts the bot container first, through the board's own start
  path (`IdleStopService.ensureStartedAndHealthy`, the call `claimQueuedRun`
  uses for an idle-stopped container: the driver's start, then a check that the
  container is running and healthy). A healthy container is followed by the
  ordinary resume of the agent.
- A start that fails is retried no sooner than 15 minutes after the previous
  attempt, 4 attempts in all (activity row
  `agent.auto_resume_container_start_failed` for each). After the fourth the
  board gives up once: `agent.auto_resume_exhausted` and the critical
  `agent_error_alert` card, as for any other give-up, and the agent is skipped
  until an operator acts. Each attempt is written to the state
  (`containerStartFailures`) before the start, so a crash or an overlapping
  pass cannot repeat it.
- A resume that follows a healthy start counts in the ordinary streak and its
  cap (3 within the failure window), so a container that starts and still
  refuses the gateway cannot loop for ever. Every other error reason keeps the
  old behaviour. A starter that is absent (no IDLE-STOP service) keeps the old
  skip.

## changelog-ru

### Агент с ошибкой «контейнер не поднят» поднимается автоматически: доска сама запускает контейнер бота (1.6.6 AUTO-RESUME)

- Когда повторы подключения прогона к шлюзу исчерпаны, доска переводит агента
  в `error` с причиной «контейнер не поднят». Автовозобновление пропускало эту
  причину (`container_not_started`), пока оператор не запустит контейнер; 07.11
  из-за этого остановленный idle-stop контейнер оставил adm-devops в ошибке на
  4,5 часа.
- Теперь проход сначала запускает контейнер бота штатным путём доски
  (`IdleStopService.ensureStartedAndHealthy` — тот же вызов, которым
  `claimQueuedRun` поднимает idle-остановленный контейнер: старт драйвера и
  проверка, что контейнер работает и здоров). После здорового контейнера идёт
  обычное возобновление агента.
- Неудавшийся старт повторяется не чаще раза в 15 минут после предыдущей
  попытки, всего 4 попытки (на каждую — строка журнала
  `agent.auto_resume_container_start_failed`). После четвёртой доска сдаётся
  один раз: `agent.auto_resume_exhausted` и критическая карточка
  `agent_error_alert`, как при любой другой сдаче, а агент пропускается, пока
  не вмешается оператор. Каждая попытка записывается в состояние
  (`containerStartFailures`) до старта, поэтому сбой или перекрывающийся проход
  не повторят её.
- Возобновление после здорового старта входит в обычную серию и её потолок
  (3 за окно сбоев), поэтому контейнер, который стартует, но по-прежнему не
  пускает шлюз, не зациклит доску. Остальные причины ошибок ведут себя как
  раньше. Если запускать нечем (нет сервиса IDLE-STOP), остаётся прежний пропуск.
