## changelog-en

### Model call limit for omp_local runs (1.6.8 OMP-RUN-GUARD-1)

- An `omp_local` run had no limit on model calls, only `timeoutSec` (3 hours). On 13.11.2026 omp sessions averaged 101 model calls (median 60, 90th percentile 239, maximum 494); 41% of all omp calls were made after the 100th call of a session and 27% after the 150th.
- The adapter now feeds the board's run guard from omp's JSON event stream: every `turn_start` is one model call, every `tool_execution_start` is one tool call. The limit is the same as for hermes: 150 calls by default, overridden by the same settings (agent card `runGuard.modelCallLimit`, team liveness `runGuard`, `MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT`).
- 15 model calls before the limit the agent gets the wrap-up message (commit, push, write a comment on the task). The adapter leaves it in a steer file and a small omp extension loaded with the run (`--extension`) hands it to the session at the next step boundary.
- On the first call past the limit the adapter stops the omp process (SIGTERM, then SIGKILL after `graceSec`) and reports the stop to the board; the existing run-guard continuation (`run-guard-stop`) decides about the next run. The other guard stops (read-only exploration, repeated call, idle) now apply to omp runs as well.
- The hint text moved from the hermes gateway adapter to `@myrmidon/adapter-utils/run-guard-hint`, so both adapters say the same thing.
- A run the guard stopped over SSH restores its workspace like a run that hit the adapter timeout.

## changelog-ru

### Предел вызовов модели для прогонов omp_local (1.6.8 OMP-RUN-GUARD-1)

- У прогона `omp_local` не было предела вызовов модели, только `timeoutSec` (3 часа). 13.11.2026 сеанс omp делал в среднем 101 вызов (медиана 60, 90-й процентиль 239, максимум 494); 41 % вызовов omp приходилось на вызовы после сотого в сеансе и 27 % - после 150-го.
- Адаптер теперь кормит защиту прогона доски из потока JSON-событий omp: каждый `turn_start` - один вызов модели, каждый `tool_execution_start` - один вызов инструмента. Предел тот же, что у hermes: по умолчанию 150 вызовов, переопределяется теми же настройками (карточка агента `runGuard.modelCallLimit`, `runGuard` в настройках живости команды, `MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT`).
- За 15 вызовов до предела агент получает сообщение «сохрани работу» (коммит, пуш, комментарий в задаче). Адаптер кладёт его в файл подсказки, а небольшое расширение omp, загружаемое с прогоном (`--extension`), передаёт его сеансу на ближайшей границе шага.
- На первом вызове сверх предела адаптер останавливает процесс omp (SIGTERM, затем SIGKILL через `graceSec`) и сообщает доске об остановке; о следующем прогоне решает существующее продолжение `run-guard-stop`. Остальные остановки защиты (чтение без правок, повтор вызова, простой) теперь действуют и для прогонов omp.
- Текст подсказки перенесён из адаптера шлюза hermes в `@myrmidon/adapter-utils/run-guard-hint`, оба адаптера говорят одно и то же.
- Прогон, остановленный защитой по SSH, возвращает рабочую копию так же, как прогон, упёршийся в таймаут адаптера.
