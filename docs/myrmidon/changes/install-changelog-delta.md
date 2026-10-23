## changelog-en

### ONE-COMMAND-INSTALL: installer fixes since 1.6.5 (CPU baseline, dockergate wiring, built-in help)

The 1.6.5 entry describes the first installer. The installer in this release also does the following:

- It reads the CPU feature flags and refuses a processor below the x86-64-v2 baseline (SSE4.2, POPCNT, CMPXCHG16B) before touching the machine: the board image carries native code built for that baseline and dies minutes after start on anything older (`MYRMIDON_INSTALL_CPUINFO` overrides the source of the flags).
- The dockergate service is wired the way a working deployment needs it: it joins the group that owns the docker socket (the GID is read from the socket, kept in `deploy.env` as `MYRMIDON_DOCKER_GID` and passed through `group_add`), shares the host PID namespace (`pid: host`) so its `/proc` lookup of the board's main process resolves, and its configuration file is written `0640` for the image's unprivileged user instead of a root-only `0600`.
- The documented form pipes the script into `bash`, so the script carries its own manual: `--help` prints the command, every option and the update promise, and an option missing its value is named in plain language instead of dying with a bare shell error.
- A release manifest that names no board image digest is refused.
- Tests (`scripts/myrmidon/install/install.test.mjs`) additionally cover the manifest without a board digest, a CPU below the baseline refused before the machine is touched, and `--help` plus a missing option value when the script is piped to bash.

## changelog-ru

### ONE-COMMAND-INSTALL: правки установщика после 1.6.5 (базовый уровень CPU, подключение dockergate, встроенная справка)

Запись 1.6.5 описывает первый установщик. В этом выпуске он дополнительно делает следующее:

- Читает флаги процессора и отказывает до изменений в системе, если процессор ниже базового уровня x86-64-v2 (SSE4.2, POPCNT, CMPXCHG16B): образ доски собирается под этот уровень и на более старом CPU умирает через несколько минут после старта (`MYRMIDON_INSTALL_CPUINFO` переопределяет источник флагов).
- Сервис dockergate подключён так, как нужно рабочему развёртыванию: входит в группу владельца сокета docker (GID читается у самого сокета, хранится в `deploy.env` как `MYRMIDON_DOCKER_GID` и выдаётся через `group_add`), делит с хостом пространство имён PID (`pid: host`) — иначе его поиск главного процесса доски через `/proc` не находит цель, — а файл его конфигурации записывается `0640` для непривилегированного пользователя образа, а не доступным только root `0600`.
- Документированная форма подаёт скрипт в `bash` конвейером, поэтому справка едет внутри: `--help` печатает команду запуска, все опции и обещание обновления, а опция без значения называется своим именем, а не голой ошибкой оболочки.
- Манифест выпуска без дайджеста образа доски отклоняется.
- Тесты (`scripts/myrmidon/install/install.test.mjs`) дополнительно покрывают манифест без дайджеста доски, CPU ниже базового уровня (отказ до изменений в машине), а также `--help` и опцию без значения при подаче скрипта конвейером.
