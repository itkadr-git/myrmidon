## changelog-en

### Added: shared package cache for the omp SSH runners (OPE-12722)

- A second task copy on the same omp SSH runner no longer re-downloads a full
  repository pack and a full package set. The compose template
  (`docker/agent-runtime/omp-ssh/compose.yml`) gained the optional
  `OMP_RUNNER_CACHE_DIR` — the shared cache directory on the bot data disk (the
  board's `general.botDisk.sharedPackageCachePath`; default
  `${OMP_RUNNER_DATA_DIR}/cache`, a cache private to the runner). It binds
  `<dir>/git` → `/cache/git` (read-only, owned by the board's user, created
  before the first start) and `<dir>/pnpm-omp` → `/cache/pnpm` (read-write,
  owned by uid 1000). The runners get their own `pnpm-omp` directory: the
  `<dir>/pnpm` directory is shared with the hermes bots (uid 10001), whose
  prepare step re-owns it, so a runner must not chown it.
- The omp-ssh image installs a consume-only git wrapper at `/usr/local/bin/git`
  (port of the bot wrapper's reference logic, minus the bot-local store; the
  interpreter is the absolute `/usr/bin/node`): a plain
  `git clone https://github.com/<owner>/<repo>.git` becomes
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …` when the
  board's mirror exists, so the clone borrows the mirrored objects. Any other
  clone — another host, `--dissociate`/`--filter`/`--shared`, a repository
  without a mirror — runs unchanged, and a clone never fails because of the
  wrapper. The image build now runs the wrapper (`git --version` through it,
  and a probe that it, not `/usr/bin/git`, answers) and fails if it cannot.
- The entrypoint writes the tool environment into `/etc/profile.d/` instead of
  Dockerfile ENV: sshd does not pass container environment variables to SSH
  sessions (`PermitUserEnvironment no`), so ENV never reached board-spawned
  commands. `omp-runner-cache.sh` sets `npm_config_cache_dir=/cache/pnpm`
  (pnpm's metadata cache; only when uid 1000 owns the mount, a root-owned mount
  is fixed, any other owner is left alone with a warning);
  `omp-runner-pnpm.sh` sets
  `npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store` and
  `npm_config_package_import_method=clone-or-copy`. The pnpm store stays in the
  workspace volume, one per runner, because a reflink/hardlink cannot cross a
  filesystem boundary, and inside `.paperclip-runtime`, the one directory the
  board's workspace cleanups spare and its sync never copies. pnpm 9 copies
  silently when a reflink is refused, so the store is checked by disk usage.
- Contract: `scripts/myrmidon/omp-ssh-image.test.mjs` (plain `node --test`,
  including a behavioural test of the wrapper's `rewriteArgs`), image lane
  `agent-runtime-images.yml` builds the changed Dockerfile on PR. Operator setup,
  the rollout for runners that already run, and the acceptance measure (a `df`
  delta of the data disk, not `du`) are in the "OMP SSH runner" section of
  `docker/agent-runtime/README.md` (EN/RU); production re-measurement
  (< 700 MB per second copy) happens after deploy.

## changelog-ru

### Добавлено: общий кеш пакетов для omp-исполнителей по SSH (OPE-12722)

- Вторая рабочая копия на том же omp-исполнителе больше не скачивает полный пак
  репозитория и полный набор пакетов. В шаблон compose
  (`docker/agent-runtime/omp-ssh/compose.yml`) добавлена необязательная
  переменная `OMP_RUNNER_CACHE_DIR` — каталог общего кеша на диске данных ботов
  (`general.botDisk.sharedPackageCachePath` доски; по умолчанию
  `${OMP_RUNNER_DATA_DIR}/cache` — кеш самого исполнителя). Привязываются
  `<dir>/git` → `/cache/git` (только чтение, владелец — пользователь доски,
  создаётся до первого запуска) и `<dir>/pnpm-omp` → `/cache/pnpm` (чтение и
  запись, владелец uid 1000). У исполнителей свой каталог `pnpm-omp`: каталог
  `<dir>/pnpm` общий с ботами hermes (uid 10001), их подготовительный шаг
  возвращает ему владельца, поэтому исполнитель не должен делать его chown.
- Образ omp-ssh ставит «читающий» враппер git в `/usr/local/bin/git` (порт
  референсной логики враппера ботов без локального хранилища ботов; интерпретатор
  — абсолютный `/usr/bin/node`): обычный
  `git clone https://github.com/<owner>/<repo>.git` превращается в
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …`, если зеркало
  доски существует, и клон берёт объекты из него. Любой другой клон — другой
  хост, `--dissociate`/`--filter`/`--shared`, репозиторий без зеркала —
  выполняется без изменений, и из-за враппера клон не может сломаться. Сборка
  образа теперь запускает враппер (`git --version` через него и проверку, что
  отвечает он, а не `/usr/bin/git`) и падает, если он не работает.
- Entrypoint пишет окружение инструментов в `/etc/profile.d/`, а не через ENV
  Dockerfile: sshd не передаёт переменные окружения контейнера в SSH-сессии
  (`PermitUserEnvironment no`), поэтому ENV до команд, запущенных доской, не
  доходил. `omp-runner-cache.sh` задаёт `npm_config_cache_dir=/cache/pnpm`
  (кеш метаданных pnpm; только когда монтирование принадлежит uid 1000, каталог
  от root исправляется, у любого другого владельца — предупреждение, каталог не
  трогается); `omp-runner-pnpm.sh` задаёт
  `npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store` и
  `npm_config_package_import_method=clone-or-copy`. Хранилище pnpm остаётся в
  томе workspace, одно на исполнителя, — рефлинк/жёсткая ссылка не проходит через
  границу файловых систем, — и внутри `.paperclip-runtime`, единственного
  каталога, который не трогают очистки рабочей папки доской и который не
  синхронизируется. pnpm 9 молча копирует при отказе рефлинка, поэтому хранилище
  проверяется по занятому месту на диске.
- Контракт: `scripts/myrmidon/omp-ssh-image.test.mjs` (обычный `node --test`,
  включая поведенческий тест `rewriteArgs` враппера), образный конвейер
  `agent-runtime-images.yml` собирает изменённый Dockerfile на PR. Настройка
  оператора, выкат для уже работающих исполнителей и приёмочный замер (прирост
  `df` диска данных, а не `du`) — в разделе «Исполнитель omp по SSH»
  `docker/agent-runtime/README.md` (EN/RU); повторный замер на бою
  (< 700 МБ на вторую копию) — после выката.
