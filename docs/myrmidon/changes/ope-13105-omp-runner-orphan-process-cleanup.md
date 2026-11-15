## changelog-en

### Orphan process cleanup on the OMP runner (OPE-13105)

- Added `/usr/local/bin/run-reap` to the OMP SSH runner image (`docker/agent-runtime/Dockerfile.omp-ssh`).
  When an agent run terminates (success, error, timeout, or cancellation), the OMP adapter invokes `run-reap <task_dir>`
  on the runner to terminate lingering background processes (such as `@embedded-postgres` or child tools) whose working directory is inside the task workspace.
- The reaper checks `/proc/<pid>/cwd`, exempts system and session processes (`PID 1`, `$$`, `$PPID`, `sshd`), sends `SIGTERM`, waits up to 5 seconds, and escalates to `SIGKILL` for survivors.
- Process cleanup is executed in a `finally` block in `packages/adapters/omp-local/src/server/execute.ts` so cleanup failures are logged without altering the run outcome or failing the task.

## changelog-ru

### Очистка процессов-сирот на OMP-исполнителе (OPE-13105)

- В образ OMP SSH-исполнителя (`docker/agent-runtime/Dockerfile.omp-ssh`) добавлен скрипт `/usr/local/bin/run-reap`.
  По завершении попытки выполнения агента (успех, ошибка, таймаут или отмена) OMP-адаптер вызывает `run-reap <task_dir>`
  на исполнителе для остановки фоновых процессов (таких как `@embedded-postgres` или дочерние утилиты), чей рабочий каталог находится внутри рабочей директории задачи.
- Скрипт очистки проверяет `/proc/<pid>/cwd`, пропускает системные и сессионные процессы (`PID 1`, `$$`, `$PPID`, `sshd`), отправляет `SIGTERM`, ожидает до 5 секунд и добивает выживших с помощью `SIGKILL`.
- Очистка выполняется в блоке `finally` в `packages/adapters/omp-local/src/server/execute.ts`, благодаря чему ошибки очистки только логируются и не меняют статус выполнения и результат задачи.
