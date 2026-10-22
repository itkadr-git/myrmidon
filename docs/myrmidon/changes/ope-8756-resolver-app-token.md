## changelog-en

### The pull-request resolver reads private repositories through the shared GitHub identity (OPE-8756)

- `server/src/services/github-external-object-provider.ts`: the token provider
  now depends on the repository, `(companyId, repository)`. Order: a company
  secret by name; otherwise the single GitHub App of the shared identity whose
  `allowedRepos` matches the repository — a read-only installation token
  (`contents: read`, `pull_requests: read`, metadata), cached by
  `mintGitHubAppInstallationToken`; otherwise anonymous, as before. Two Apps
  matching one repository fail closed (no token). Secrets are read as the
  system consumer `github-external-object-resolver`; neither the token nor the
  key reaches a log or a response.
- Before, a private repository such as `myrmidon-deploy` was read anonymously,
  GitHub answered 404, and `issue_done_pull_request_gate` kept tasks with
  merged PRs blocked with the misleading "until the PR is merged".
- `PullRequestMergeDetails.access = "denied"` marks a PR the board cannot read
  for lack of rights (404 / 401 / 403 / unusable credentials). The gate then
  answers "Не удаётся прочитать PR <url>: у доски нет доступа к репозиторию
  <owner/repo> (настройте GitHub App/PAT)" with
  `reason: "repository_access_unavailable"`; other unknown states keep the old
  message.

## changelog-ru

### Резолвер PR читает закрытые репозитории через общую GitHub-идентичность (OPE-8756)

- `server/src/services/github-external-object-provider.ts`: провайдер токена
  теперь зависит от репозитория, `(companyId, repository)`. Порядок: секрет
  компании по имени; иначе единственное приложение общей идентичности, у
  которого `allowedRepos` подходит под репозиторий, — токен установки только на
  чтение (`contents: read`, `pull_requests: read`, metadata) с кэшем
  `mintGitHubAppInstallationToken`; иначе анонимно, как раньше. Два приложения
  на один репозиторий — fail closed (токен не выдаётся). Секреты читаются
  системным потребителем `github-external-object-resolver`; ни токен, ни ключ
  не попадают в журнал и ответы.
- Раньше закрытый репозиторий вроде `myrmidon-deploy` читался анонимно, GitHub
  отвечал 404, и `issue_done_pull_request_gate` держал задачи с влитыми PR с
  вводящим в заблуждение «пока PR не влит».
- `PullRequestMergeDetails.access = "denied"` помечает PR, который доска не
  может прочитать из-за прав (404 / 401 / 403 / негодные учётные данные). Гейт
  тогда говорит «Не удаётся прочитать PR <url>: у доски нет доступа к
  репозиторию <owner/repo> (настройте GitHub App/PAT)» с
  `reason: "repository_access_unavailable"`; прочие unknown-состояния
  сохраняют прежний текст.
