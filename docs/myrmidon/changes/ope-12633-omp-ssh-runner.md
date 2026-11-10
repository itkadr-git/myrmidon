## changelog-en

### omp agents run in their own container: the omp SSH runner (OMP-SSH-RUNNER, OPE-12633)

- New image `agent-runtime-omp-ssh`, built and signed by the agent-runtime image workflow. It adds Bun and omp (pinned like the board image), pnpm, the GitHub CLI, a C toolchain and a key-only sshd (port 2222, user `paperclip`) to the agent runtime base image.
- An `omp_local` agent is attached to a board SSH environment that points at one runner container per agent (template: `docker/agent-runtime/omp-ssh/compose.yml`). The runner has its own limits; the defaults are those of an engineer bot container: 4 GB, 1 CPU, 1024 processes. omp, its tools and the builds it starts run there, not in the board container. The board syncs the workspace and streams the output.
- The procedure is in the "OMP SSH runner" section of `docker/agent-runtime/README.md`.

## changelog-ru

### Агенты omp работают в своём контейнере: исполнитель omp по SSH (OMP-SSH-RUNNER, OPE-12633)

- Новый образ `agent-runtime-omp-ssh`. Его собирает и подписывает процесс сборки образов сред агентов. Поверх базового образа он добавляет:
  - Bun и omp, закреплённые как в образе доски;
  - pnpm, GitHub CLI и набор сборки C;
  - sshd только по ключу (порт 2222, пользователь `paperclip`).
- Агент `omp_local` привязывается к SSH-окружению доски. Окружение указывает на отдельный контейнер-исполнитель, по одному на агента (шаблон: `docker/agent-runtime/omp-ssh/compose.yml`).
  - У исполнителя свои лимиты, по умолчанию как у контейнера бота-инженера: 4 ГБ, 1 CPU, 1024 процесса.
  - omp, его инструменты и запущенные им сборки работают там, а не в контейнере доски. Доска синхронизирует рабочую копию и передаёт вывод.
- Порядок настройки — в разделе «Исполнитель omp по SSH» файла `docker/agent-runtime/README.ru.md`.
