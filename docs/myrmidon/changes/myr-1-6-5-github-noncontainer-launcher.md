## changelog-en

### The GitHub App of the board serves non-container runs too (GITHUB-SHARED-IDENTITY)

- A run whose execution target is local or SSH — the development agents on the
  build machine, and the bots whose container `fleetd` starts on a second
  machine — had no GitHub credential path of its own: the launcher that the
  board stages for such a run asked the broker without naming a repository, so a
  run whose only identity is a self-hosted GitHub App never received a token,
  and the agents kept pushing with a static token from their environment.
- The launcher now stages `git-credential-paperclip` next to its `git` and `gh`
  and gives Git the same configuration the bot image installs in
  `/etc/gitconfig`: the leading empty `credential.helper`, ours scoped to
  github.com over https, and `useHttpPath = true`. git then hands the helper the
  repository path of the operation and the helper asks the broker for exactly
  that `owner/repo`; the `gh` wrapper names the repository from `-R`/`--repo`,
  `GH_REPO` or the `origin` remote, and a `git` command names the remote written
  into its arguments or the `origin` remote of its working directory.
- An operation that names no usable repository, or one no App serves, stays
  without managed credentials: git and `gh` keep working exactly as before.
  Only the token, the terminal-prompt switch and the commit identity are taken
  from the broker's answer, so a broker-supplied credential helper can never
  replace the staged one. No token, static or minted, is written to a file.
- After the agents of the second list are moved over, their static GitHub tokens
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) are removed, so one path serves
  every development agent.

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