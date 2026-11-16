## changelog-en

### Agent-registered GitHub pull requests are tracked by the webhook (1.6.9)

When an agent registers a `pull_request` work product with `provider=github` by URL only (`https://github.com/<owner>/<repo>/pull/<N>`), the server now fills `external_id` in the webhook format (`<owner>/<repo>#pull/<N>`) and `metadata.repo`, `metadata.repository` and `metadata.number`; the same applies to PATCH. Registering the same PR again for a task updates the existing record instead of adding a second one. As a result the GitHub `synchronize` webhook finds agent records, updates `headSha` and writes `issue.work_product_head_changed`, so pushes to the PR are visible on the board and no duplicate PR records appear.

## changelog-ru

### Пулл-реквесты, зарегистрированные агентом, отслеживаются вебхуком GitHub (1.6.9)

Когда агент регистрирует рабочий продукт `pull_request` с `provider=github` только по URL (`https://github.com/<owner>/<repo>/pull/<N>`), сервер теперь сам заполняет `external_id` в формате вебхука (`<owner>/<repo>#pull/<N>`) и `metadata.repo`, `metadata.repository`, `metadata.number`; то же при PATCH. Повторная регистрация того же PR на задаче обновляет существующую запись, а не создаёт вторую. Благодаря этому вебхук GitHub `synchronize` находит записи агентов, обновляет `headSha` и пишет `issue.work_product_head_changed`: пуши в PR видны на доске, дублей PR нет.
