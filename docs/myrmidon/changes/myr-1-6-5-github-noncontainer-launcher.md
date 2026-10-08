## changelog-en

### The GitHub App of the board serves non-container runs too (GITHUB-SHARED-IDENTITY)

- A run whose execution target is local or SSH (the development agents on the
  build machine, and bots whose container `fleetd` starts on a second machine)
  had no GitHub credential path: the launcher staged for it asked the broker
  without naming a repository, so a run whose only identity is a self-hosted
  GitHub App never got a token and the agents kept pushing with a static token.
- The launcher now stages `git-credential-paperclip` next to its `git` and `gh`
  and gives Git the configuration the bot image installs in `/etc/gitconfig`: the
  leading empty `credential.helper`, ours scoped to github.com over https, and
  `useHttpPath = true`. git hands the helper the repository path and the helper
  asks the broker for exactly that `owner/repo`; the `gh` wrapper names the
  repository from `-R`/`--repo`, `GH_REPO` or the `origin` remote, and a `git`
  command from the remote in its arguments or the `origin` of its directory.
- An operation that names no usable repository, or one no App serves, stays
  without managed credentials and works as before. Only the token, the
  terminal-prompt switch and the commit identity are taken from the broker's
  answer, so a broker-supplied helper never replaces the staged one. No token is
  written to a file.
- Once the second list's agents are moved over, their static GitHub tokens
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) are removed.

## changelog-ru

### GitHub-приложение доски обслуживает и не-контейнерные прогоны (GITHUB-SHARED-IDENTITY)

- У прогона с локальной или SSH-целью — агенты разработки на сборочной машине
  и боты, контейнер которых поднимает `fleetd` на второй машине, — своего пути
  к учётным данным GitHub не было: лаунчер, который доска выкладывает такому
  прогону, спрашивал брокера, не называя репозитория, поэтому прогон, у
  которого единственная личность — своё GitHub App, токена не получал, и
  агенты продолжали пушить статическим токеном из окружения.
- Теперь лаунчер выкладывает `git-credential-paperclip` рядом со своими `git`
  и `gh` и отдаёт git ту же конфигурацию, что образ бота кладёт в
  `/etc/gitconfig`: пустой `credential.helper` впереди, наш — привязанный к
  github.com по https, и `useHttpPath = true`. git передаёт хелперу путь
  репозитория операции, и хелпер спрашивает брокера ровно за этот `owner/repo`;
  обёртка `gh` называет репозиторий из `-R`/`--repo`, `GH_REPO` или remote
  `origin`, а команда `git` — из remote в своих аргументах или из remote
  `origin` своего рабочего каталога.
- Операция, не назвавшая годного репозитория (или такой, который не
  обслуживает ни одно приложение), остаётся без управляемых учётных данных:
  git и `gh` работают точно так же, как раньше. Из ответа брокера берутся
  только токен, выключатель запроса пароля и личность коммиттера, поэтому
  присланный брокером credential helper никогда не подменит выложенный. Ни
  один токен — ни статический, ни выданный — не пишется в файл.
- После перевода агентов второго списка их статические токены GitHub
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) снимаются, чтобы у всех агентов
  разработки был один путь.