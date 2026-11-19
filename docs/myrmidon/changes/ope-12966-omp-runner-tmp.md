## changelog-en

### The omp SSH runner's /tmp moves to the data disk and is pruned (OPE-12966)

- The SSH runner compose template (`docker/agent-runtime/omp-ssh/compose.yml`) now binds
  `${OMP_RUNNER_DATA_DIR}/tmp` at `/tmp`. Until now the runner's `/tmp` stayed in the
  container's write layer on the host's root disk: tests and task tooling wrote gigabytes
  there (15.8 GB in two days) and nothing removed them. Create `tmp/` with mode `1777` next
  to `workspace/`, `home/` and `hostkeys/` before the first start; a running runner needs
  the volume added to its compose file and a recreate.
- The host GC (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) removes top-level entries of
  `<runner root>/<runner>/tmp` that nothing inside has changed in for 24 hours
  (`--runner-tmp-ttl`, at least 3). It runs only when a runner root is configured
  (`--runner-root` / `HOST_GC_RUNNER_ROOTS`, set by the repo's systemd unit), never follows a
  symlink or leaves the filesystem, and never removes `tmp` itself. Journal events
  `runner-tmp-removed`, `runner-tmp-remove-failed`, `runner-tmp-skipped`,
  `runner-tmp-scan-failed`; the counter `runnerTmpRemoved`.

## changelog-ru

### /tmp SSH-исполнителя omp переехал на диск данных и очищается (OPE-12966)

- Шаблон compose SSH-исполнителя (`docker/agent-runtime/omp-ssh/compose.yml`) теперь привязывает
  `${OMP_RUNNER_DATA_DIR}/tmp` к `/tmp`. Раньше `/tmp` исполнителя оставался в слое записи
  контейнера на корневом диске хоста: тесты и рабочие материалы задач писали туда гигабайты
  (15,8 ГБ за двое суток), и никто их не убирал. Каталог `tmp/` с режимом `1777` нужно создать
  рядом с `workspace/`, `home/` и `hostkeys/` до первого запуска; работающему исполнителю нужно
  добавить том в compose-файл и пересоздать контейнер.
- Хостовая уборка (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) удаляет записи верхнего
  уровня в `<корень исполнителей>/<исполнитель>/tmp`, в которых ничего не менялось 24 часа
  (`--runner-tmp-ttl`, не меньше 3). Работает только при заданном корне исполнителей
  (`--runner-root` / `HOST_GC_RUNNER_ROOTS`, его задаёт systemd-юнит репозитория), не идёт по
  символическим ссылкам, не выходит за файловую систему и не удаляет саму `tmp`. События
  журнала: `runner-tmp-removed`, `runner-tmp-remove-failed`, `runner-tmp-skipped`,
  `runner-tmp-scan-failed`; счётчик `runnerTmpRemoved`.
