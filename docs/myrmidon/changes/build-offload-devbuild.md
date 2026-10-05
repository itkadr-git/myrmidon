## changelog-en

### `devbuild`: bot builds and tests on the build VPS (BUILD-OFFLOAD B)

- The dev bot image carries `/opt/paperclip/bin/devbuild` (root-owned, from
  `docker/bot-runtime/devbuild/devbuild`): it rsyncs the `/workspace` repo
  copy (`.git` included, `node_modules` and build outputs excluded) to
  `$DEVBUILD_BASE/<bot>/<repo>/` on the shared build VPS over ssh, runs the
  given command there with the shared caches exported
  (`npm_config_store_dir=/srv/devcache/pnpm`, `GOMODCACHE`, `GOCACHE`,
  `GRADLE_USER_HOME` — created on first run, shared by all bots) and passes
  the exit code through. Heavy jobs (`pnpm -r typecheck`, full test suites,
  `go test`) run there instead of inside the 1 CPU / 3 GB bot container;
  editing, git and pushing stay local.
- Connection settings come only from the bot profile env (`DEVBUILD_HOST`,
  `DEVBUILD_USER`, `DEVBUILD_BASE`) — nothing is baked into the image or
  tests; without them the script prints a pointer to the `devbuild` skill and
  exits 1. The ssh key is read from `/opt/devbuild-ssh/id_ed25519`, mounted by
  the runtime template; key authorization and remote resource limits are the
  fleet operator's part. The image adds `rsync` for the transport.
- New skill `skills/devbuild/SKILL.md` documents when to use it, the env
  table, where the caches live, how to collect results and the typical
  errors, with pnpm/tsc/go examples.

## changelog-ru

### `devbuild`: сборки и тесты ботов на сборочном VPS (BUILD-OFFLOAD B)

- Образ dev-бота несёт `/opt/paperclip/bin/devbuild` (root-owned, из
  `docker/bot-runtime/devbuild/devbuild`): rsync копии репозитория
  `/workspace` (`.git` передаётся, `node_modules` и продукты сборки
  исключены) в `$DEVBUILD_BASE/<bot>/<repo>/` на общий сборочный VPS по ssh,
  запуск команды там с общими кэшами (`npm_config_store_dir=/srv/devcache/pnpm`,
  `GOMODCACHE`, `GOCACHE`, `GRADLE_USER_HOME` — создаются при первом прогоне,
  общие для всех ботов), код выхода транслируется. Тяжёлые задачи
  (`pnpm -r typecheck`, полные тесты, `go test`) идут там, а не в контейнере
  бота на 1 CPU / 3 ГБ; правка, git и пуш остаются локальными.
- Параметры подключения — только из env профиля бота (`DEVBUILD_HOST`,
  `DEVBUILD_USER`, `DEVBUILD_BASE`), в образ и тесты ничего не зашито; без них
  скрипт печатает указание на навык `devbuild` и завершается с кодом 1.
  Ключ ssh читается из `/opt/devbuild-ssh/id_ed25519`, который монтирует
  шаблон рантайма; авторизация ключа и лимиты на VPS — часть оператора
  флота. В образ добавлен `rsync` для транспорта.
- Новый навык `skills/devbuild/SKILL.md`: когда применять, таблица
  переменных, где лежат кэши, как забрать результат, типовые ошибки,
  примеры pnpm/tsc/go.
