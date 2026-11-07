## changelog-en

### Heartbeat: an old exhausted connect retry no longer flips a healthy agent to error (1.6.6 OPE-12150)

The stranded-issue sweep re-schedules the last run of an `in_progress` issue on every pass. When that run had used up its `container_not_started` retry budget, every pass wrote `status=error`, «контейнер не поднят» on the agent, even though its container was healthy and later runs of the agent had succeeded (prod 07.11: adm-devops returned to error 15–60 s after every clear). The exhausted budget now marks the agent only when no run of this agent succeeded after the exhausted one. A status patch that moves an agent out of `error` also clears `errorReason`.

## changelog-ru

### Heartbeat: старый исчерпанный повтор подключения больше не переводит здорового агента в error (1.6.6 OPE-12150)

Обход застрявших задач на каждом проходе заново планирует последний прогон задачи в `in_progress`. Если у этого прогона кончился бюджет повторов `container_not_started`, каждый проход записывал агенту `status=error` «контейнер не поднят», хотя контейнер был здоров, а более поздние прогоны агента прошли успешно (бой 07.11: adm-devops возвращался в error через 15–60 с после каждого снятия). Теперь исчерпанный бюджет помечает агента, только если после исчерпанного прогона у этого агента не было успешного. Перевод агента из `error` правкой статуса заодно очищает `errorReason`.
