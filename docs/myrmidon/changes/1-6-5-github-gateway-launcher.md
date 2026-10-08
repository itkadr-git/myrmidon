## changelog-en

### The managed GitHub launcher reaches agents that start through the gateway (GITHUB-SHARED-IDENTITY)

- The launcher — the `git` and `gh` wrappers plus `git-credential-paperclip` —
  is staged by the board in its own filesystem for a run with a local or SSH
  execution target. A run that starts through the `hermes_gateway` adapter has
  no execution target on the board side, so those paths never existed where the
  run happens: the agent pushed and opened pull requests with the static
  `MYRMIDON_GITHUB_TOKEN` from its environment, and its `run_identity_contexts`
  row stayed without a GitHub identity.
- The gateway adapter now ships the launcher bodies with the run request, and a
  gateway stages them per run: under its own temporary root, in a directory
  named by the run id, first on that run's `PATH`, with the login-shell profiles
  and `GH_CONFIG_DIR` that keep the staged directory in place. Only that run's
  terminals and `execute_code` children see it — one gateway process serves many
  concurrent runs from threads that share one environment, so the binding is
  per-context, never process-wide.
- The bodies are program text and carry no credential: the token still comes
  from the run's broker capability, and the staged helper asks for it per
  invocation for the repository the operation names. A run without a capability,
  or a request whose launcher payload is malformed (wrong version, a file name
  outside the fixed set, an oversize body), stages nothing and behaves exactly
  as before — no partial directory, no directory another run could be pointed
  at. Nothing is written to a file, and no static token is needed anywhere.

## changelog-ru

### Управляемый GitHub-лаунчер доезжает и до агентов, стартующих через шлюз (GITHUB-SHARED-IDENTITY)

- Лаунчер — обёртки `git` и `gh` и хелпер `git-credential-paperclip` — доска
  выкладывает в своей файловой системе для прогона с локальной или SSH-целью.
  У прогона, который стартует через адаптер `hermes_gateway`, цели исполнения
  на стороне доски нет, поэтому этих путей там, где прогон идёт, никогда не
  было: агент пушил и открывал pull request'ы статическим
  `MYRMIDON_GITHUB_TOKEN` из окружения, а его строка `run_identity_contexts`
  оставалась без личности GitHub.
- Теперь адаптер шлёт тела лаунчера вместе с запросом прогона, а шлюз
  выкладывает их на прогон: в своём временном корне, в каталоге с именем
  идентификатора прогона, первым в `PATH` этого прогона, вместе с профилями
  login-оболочек и `GH_CONFIG_DIR`, которые удерживают выложенный каталог на
  месте. Видят его только терминалы и дети `execute_code` этого прогона: один
  процесс шлюза обслуживает много одновременных прогонов из потоков с общим
  окружением, поэтому привязка — на контекст, никогда на процесс.
- Тела — это текст программ, учётных данных в них нет: токен по-прежнему
  приходит из capability прогона, и выложенный хелпер спрашивает его на каждый
  вызов для того репозитория, который называет операция. Прогон без capability
  или запрос с испорченной полезной нагрузкой лаунчера (не та версия, имя
  файла вне фиксированного набора, слишком большое тело) не выкладывает
  ничего и ведёт себя ровно как раньше — ни частичного каталога, ни каталога,
  на который можно указать другому прогону. В файл не пишется ничего, и
  статический токен не нужен нигде.