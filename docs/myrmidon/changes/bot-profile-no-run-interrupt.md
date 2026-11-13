## changelog-en

### An agent card edit no longer recreates the bot container under a running run (BOT-PROFILE-NO-RUN-INTERRUPT)

- A change that has to stop a bot gateway (restart-class profile change, image or resource drift) used to open a maintenance window, wait for the agent's run to drain and, at the drain deadline, interrupt it ("Interrupted by maintenance mode" / "Gateway shutdown interrupted the run."). The reconciler now looks at the agent's live runs first: with a run in flight the pass returns `deferred` without opening a window, and the existing deferred-rollout watcher (`myrmidonBotRolloutDeferred`) applies it after the run ended. The check is repeated under the window to close the race with a run admitted in between.
- The watcher's busy gate now reads the run table; before it read the window view, which reports 0 for an agent with no window.
- Only a record that waited past `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (6 h by default) still drains and interrupts, so a bot that never frees up converges. An unhealthy gateway is recovered at once, not deferred.
- `runtimeConfig.heartbeat.*` is read by the board only, except `maxConcurrentRuns`, which is written to the gateway's `config.yaml`; pinned by tests. A change of that one field is still a restart-class change, but it is now deferred under a running run.

## changelog-ru

### Правка карточки агента не пересоздаёт контейнер бота при идущем прогоне (BOT-PROFILE-NO-RUN-INTERRUPT)

- Изменение, требующее остановки шлюза бота (смена профиля класса «перезапуск», образа или ресурсов), раньше открывало окно обслуживания, ждало окончания прогона и по сроку слива прерывало его («Interrupted by maintenance mode» / «Gateway shutdown interrupted the run.»). Теперь сверка сначала смотрит живые прогоны агента: при идущем прогоне проход возвращает `deferred` без окна, а существующий сторож отложенных перекатов (`myrmidonBotRolloutDeferred`) применяет изменение после окончания прогона. Проверка повторяется внутри окна, чтобы закрыть гонку с прогоном, допущенным между ними.
- Проверка «занят» у сторожа теперь читает таблицу прогонов; раньше читалось окно, которое для агента без окна даёт 0.
- Прерывает по-прежнему только запись, прождавшая дольше `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (по умолчанию 6 ч), чтобы вечно занятый бот всё же сошёлся. Нездоровый шлюз восстанавливается сразу, без откладывания.
- `runtimeConfig.heartbeat.*` читает только доска, кроме `maxConcurrentRuns`: он пишется в `config.yaml` шлюза; закреплено тестами. Смена этого поля остаётся изменением класса «перезапуск», но теперь откладывается при идущем прогоне.
