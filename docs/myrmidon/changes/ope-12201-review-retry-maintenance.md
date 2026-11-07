## changelog-en

### Review stage: a reviewer run interrupted by maintenance no longer blocks the stage (1.6.6 OPE-12201)

The maintenance drain of a deploy interrupts running reviewer runs (`myrmidon_maintenance_interrupted`). The review-stage recovery counted them as failed reviewer attempts, and after two of them moved the stage to `blocked` («retried the pending execution-review participant twice…»), although the review was fine (prod 07.11, rc.46: OPE-12058, OPE-12091). Such a run now re-wakes the reviewer without spending the decision budget; the activity row has kind `maintenance_retry`, which the budget counter ignores.

## changelog-ru

### Этап ревью: прогон ревьюера, прерванный обслуживанием, больше не блокирует этап (1.6.6 OPE-12201)

Слив обслуживания при выкате прерывает идущие прогоны ревьюеров (`myrmidon_maintenance_interrupted`). Восстановление этапа ревью считало их неудачными попытками ревьюера и после двух таких попыток переводило этап в `blocked` («retried the pending execution-review participant twice…»), хотя ревью шло нормально (бой 07.11, rc.46: OPE-12058, OPE-12091). Теперь такой прогон снова будит ревьюера и не тратит бюджет решений; строка активности получает вид `maintenance_retry`, который счётчик бюджета не учитывает.
