## changelog-en

### Added: shared package cache for the omp SSH runners (OPE-12722)

- A second task copy on the same omp SSH runner no longer re-downloads a full
  repository pack and a full package set. The compose template
  (`docker/agent-runtime/omp-ssh/compose.yml`) gained `OMP_RUNNER_CACHE_DIR` —
  the shared cache directory on the bot data disk (the board's
  `general.botDisk.sharedPackageCachePath`), bound as `<dir>/git` → `/cache/git`
  (read-only) and `<dir>/pnpm` → `/cache/pnpm` (read-write).
- The omp-ssh image installs a consume-only git wrapper at `/usr/local/bin/git`
  (port of the bot wrapper's reference logic, minus the bot-local store): a
  plain `git clone https://github.com/<owner>/<repo>.git` becomes
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …` when the
  board's mirror exists, so the clone borrows the mirrored objects. Any other
  clone — another host, `--dissociate`/`--filter`/`--shared`, a repository
  without a mirror — runs unchanged, and a clone never fails because of the
  wrapper.
- The entrypoint writes the tool environment into `/etc/profile.d/` instead of
  Dockerfile ENV: sshd does not pass container environment variables to SSH
  sessions (`PermitUserEnvironment no`), so ENV never reached board-spawned
  commands. `omp-runner-cache.sh` sets `npm_config_cache_dir=/cache/pnpm` (only
  when the mount exists); `omp-runner-pnpm.sh` sets
  `npm_config_store_dir=/workspace/.pnpm-store` and
  `npm_config_package_import_method=clone` — the pnpm store stays in the
  workspace volume, one per runner, because a reflink/hardlink cannot cross a
  filesystem boundary.
- Contract: `scripts/myrmidon/omp-ssh-image.test.mjs` (12 tests, plain
  `node --test`), image lane `agent-runtime-images.yml` builds the changed
  Dockerfile on PR. Operator setup and the `du -xs` acceptance measure are in
  the "OMP SSH runner" section of `docker/agent-runtime/README.md` (EN/RU);
  production re-measurement (< 700 MB per second copy) happens after deploy.

## changelog-ru

### Добавлено: общий кеш пакетов для omp-исполнителей по SSH (OPE-12722)

- Вторая рабочая копия на том же omp-исполнителе больше не скачивает полный пак
  репозитория и полный набор пакетов. В шаблон compose
  (`docker/agent-runtime/omp-ssh/compose.yml`) добавлена переменная
  `OMP_RUNNER_CACHE_DIR` — каталог общего кеша на диске данных ботов
  (`general.botDisk.sharedPackageCachePath` доски); привязываются
  `<dir>/git` → `/cache/git` (только чтение) и `<dir>/pnpm` → `/cache/pnpm`
  (чтение и запись).
- Образ omp-ssh ставит «читающий» враппер git в `/usr/local/bin/git` (порт
  референсной логики враппера ботов без локального хранилища ботов): обычный
  `git clone https://github.com/<owner>/<repo>.git` превращается в
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …`, если зеркало
  доски существует, и клон берёт объекты из него. Любой другой клон — другой
  хост, `--dissociate`/`--filter`/`--shared`, репозиторий без зеркала —
  выполняется без изменений, и из-за враппера клон не может сломаться.
- Entrypoint пишет окружение инструментов в `/etc/profile.d/`, а не через ENV
  Dockerfile: sshd не передаёт переменные окружения контейнера в SSH-сессии
  (`PermitUserEnvironment no`), поэтому ENV до команд, запущенных доской, не
  доходил. `omp-runner-cache.sh` задаёт `npm_config_cache_dir=/cache/pnpm`
  (только при наличии монтирования); `omp-runner-pnpm.sh` задаёт
  `npm_config_store_dir=/workspace/.pnpm-store` и
  `npm_config_package_import_method=clone` — хранилище pnpm остаётся в томе
  workspace, одно на исполнителя: рефлинк/жёсткая ссылка не проходит через
  границу файловых систем.
- Контракт: `scripts/myrmidon/omp-ssh-image.test.mjs` (12 тестов, обычный
  `node --test`), образный конвейер `agent-runtime-images.yml` собирает
  изменённый Dockerfile на PR. Настройка оператора и приёмочный замер `du -xs`
  — в разделе «Исполнитель omp по SSH» `docker/agent-runtime/README.md`
  (EN/RU); повторный замер на бою (< 700 МБ на вторую копию) — после выката.
