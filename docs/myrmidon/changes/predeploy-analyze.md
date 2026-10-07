---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### The predeploy copy gets planner statistics before the board is checked (1.6.5 PREDEPLOY-ANALYZE)

- The predeploy board check now runs `ANALYZE` on the throwaway database right
  after the dump is restored, as a separate step logged as `analyze`. A restored
  dump carries rows but no planner statistics, so on the copy the issues list
  ran on default estimates and missed the 30 s route budget (the rc.8 rollout
  stopped there on 07.10 while the same route answered on production).
- The step runs after any restore command, including an overridden
  `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`. Its command can be overridden with
  `MYRMIDON_PREDEPLOY_ANALYZE_COMMAND`. A failed ANALYZE is a warning, not a stop.

## changelog-ru

### Копия для предвыкатной проверки получает статистику планировщика до проверки доски (1.6.5 PREDEPLOY-ANALYZE)

- Предвыкатная проверка доски теперь выполняет `ANALYZE` на временной базе сразу
  после восстановления дампа отдельным шагом с логом `analyze`. Восстановленный
  дамп несёт строки, но не статистику планировщика, поэтому на копии список
  задач шёл по оценкам по умолчанию и не укладывался в 30 с на маршрут (выкат
  rc.8 остановился здесь 07.10, хотя тот же маршрут на боевой отвечал).
- Шаг выполняется после любой команды восстановления, в том числе
  переопределённой `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`. Его команду можно
  переопределить через `MYRMIDON_PREDEPLOY_ANALYZE_COMMAND`. Сбой ANALYZE — предупреждение, не остановка.

## divergence

| PREDEPLOY-ANALYZE | Предвыкатная проверка доски выполняет `ANALYZE` на копии боевой БД после восстановления дампа (отдельный шаг `analyze`, в том числе при переопределённой команде восстановления; команда переопределяется `MYRMIDON_PREDEPLOY_ANALYZE_COMMAND`; сбой — предупреждение) | Наш файл `scripts/myrmidon/deploy/predeploy-board-check.sh` (маркер `myrmidon(PREDEPLOY-ANALYZE)`) | Выкат rc.8 07.10 остановился на PREDEPLOY-DB-CHECK: GET issues?limit=1 на свежей копии не уложился в 30 с (нет статистики после pg_restore) | `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (три теста PREDEPLOY-ANALYZE) | Никогда, наше поведение | (этот PR) |
