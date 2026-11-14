---
settings-section: Track 5 — operations
---

## changelog-en

### A bot container Docker marks unhealthy is no longer restarted while its run is alive (BOT-HEALTH-LIVE-RUN)

- On 14.11 the container health probe (`curl /health`, 5 s timeout) timed out under host load (load 9-12) and Docker marked live bots `unhealthy`. The board restarted them at once and cut two running runs (`myrmidon_maintenance_interrupted`).
- Now, when the container is `unhealthy` but the agent has a running run whose newest progress (run event, output flush or useful action) is younger than 120 s, the recovery waits for the next pass and the activity log records "health recovery deferred: live run". A silent run, or no run, is recovered as before.
- The window is `MYRMIDON_BOT_HEALTH_LIVE_RUN_GRACE_SEC` (default 120, `0` = off).

## changelog-ru

### Контейнер бота, который Docker счёл unhealthy, больше не перезапускается, пока его прогон жив (BOT-HEALTH-LIVE-RUN)

- 14.11 проверка здоровья контейнера (`curl /health`, таймаут 5 с) не укладывалась в срок при нагрузке хоста (load 9-12), и Docker помечал живых ботов `unhealthy`. Доска тут же перезапускала их и оборвала два идущих прогона (`myrmidon_maintenance_interrupted`).
- Теперь, если контейнер `unhealthy`, но у агента идёт прогон, чей последний признак работы (событие прогона, вывод или полезное действие) моложе 120 с, восстановление откладывается до следующего прохода, а в журнал пишется «health recovery deferred: live run». Молчащий прогон или его отсутствие обрабатываются как раньше.
- Окно задаёт `MYRMIDON_BOT_HEALTH_LIVE_RUN_GRACE_SEC` (по умолчанию 120, `0` — выключено).

## settings-en

| `MYRMIDON_BOT_HEALTH_LIVE_RUN_GRACE_SEC` | OPE-13119 | `120` | Seconds of run silence after which a bot container Docker marked `unhealthy` is restarted. While the agent has a running run whose newest progress (run event, output flush, useful action) is younger than this, the health recovery is deferred to the next pass and the activity log records `health recovery deferred: live run`; a silent run or no run is recovered at once. Read on every pass | `0` — the wait is off (always recover). Unset, empty or non-numeric — the default; at most 86400 |

## settings-ru

| `MYRMIDON_BOT_HEALTH_LIVE_RUN_GRACE_SEC` | OPE-13119 | `120` | Секунды тишины прогона, после которых контейнер бота, помеченный Docker как `unhealthy`, перезапускается. Пока у агента идёт прогон, чей последний признак работы (событие прогона, вывод, полезное действие) моложе этого окна, восстановление откладывается до следующего прохода, а в журнал пишется `health recovery deferred: live run`; молчащий прогон или его отсутствие восстанавливаются сразу. Читается на каждом проходе | `0` — ожидание выключено (восстанавливать всегда). Не задана, пустая или не число — умолчание; не больше 86400 |
