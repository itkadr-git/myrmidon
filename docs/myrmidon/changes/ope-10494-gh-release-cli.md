## changelog-en

### OPE-10494: bots ship the GitHub CLI from its own release (2.103.3)

- Bot images installed Debian's `gh` 2.46.0, which fails `gh pr view` and `gh pr edit` with "GraphQL: Projects (classic) is being deprecated"; bots retried the same command and runs stopped on repeated tool failures. Every bot image variant now carries `gh` 2.103.3 from the pinned, checksummed upstream release at `/usr/bin/gh`.

## changelog-ru

### OPE-10494: у ботов GitHub CLI из собственного выпуска (2.103.3)

- В образах ботов стоял `gh` 2.46.0 из Debian, который падает на `gh pr view` и `gh pr edit` с «GraphQL: Projects (classic) is being deprecated»; боты повторяли ту же команду, и прогоны останавливались на повторах инструмента. Во всех вариантах образа ботов теперь `gh` 2.103.3 из закреплённого выпуска с проверкой контрольной суммы, в `/usr/bin/gh`.
