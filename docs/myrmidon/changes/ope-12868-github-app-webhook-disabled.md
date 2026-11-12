## changelog-en

### GitHub App disabled-webhook attention card and addressable silence alarms (1.6.8 OPE-12868)

- Added the `github_app_webhook_disabled` critical operator attention card: when `POST /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/webhook-sync` gets HTTP 404 from GitHub on the hook-config `PATCH` (meaning **Settings → Developer settings → GitHub Apps → Webhook → Active** is off on GitHub), the server latches a process-local signal (`companyId`, `entryId`, `appId`, `webhookHost`, timestamps — no secrets) and clears it automatically once a later `webhook-sync` succeeds.
- `githubConnectionEventService.sweepWatchdog` now mints the company `issueNumber` and `identifier` (`<prefix>-N`) in a transaction when creating a `github_events_silence` alarm issue, making the alarm addressable like any other task.

## changelog-ru

### Карточка выключенного вебхука GitHub App и адресные тревоги тишины (1.6.8 OPE-12868)

- Добавлена критическая карточка внимания `github_app_webhook_disabled`: если при вызове `POST /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/webhook-sync` GitHub отвечает HTTP 404 на `PATCH` конфигурации вебхука (на странице GitHub App выключен переключатель **Settings → Developer settings → GitHub Apps → Webhook → Active**), сервер взводит process-local сигнал (`companyId`, `entryId`, `appId`, `webhookHost`, метки времени — без секретов) и автоматически снимает карточку после успешного повторного `webhook-sync`.
- `githubConnectionEventService.sweepWatchdog` при создании задачи-тревоги `github_events_silence` теперь выделяет номер `issueNumber` и идентификатор `<prefix>-N` в транзакции, чтобы тревога была адресуемой как обычная задача.
