# Server onboarding dry-run

Для предварительной проверки сервера используйте `POST /api/companies/:companyId/servers/onboarding/dry-run`.
Проверка не создаёт и не изменяет запись сервера. В запросе передаётся ровно один из
`auth.password` или `auth.privateKey`; секреты используются только во время проверки и
не возвращаются и не записываются в логи.

Проверки выполняются последовательно: DNS, SSH-аутентификация с безопасной командой
`true`, затем `sudo -n true`. Результат HTTP 200 содержит стабильные `status` и `code`
для каждой выполненной проверки. При ошибке предусловия последующие проверки указаны
в `skippedChecks`.

Основные коды: `dns_ok`, `dns_not_found`, `dns_timeout`, `dns_error`, `ssh_ok`,
`ssh_connection_refused`, `ssh_unreachable`, `ssh_timeout`, `ssh_auth_failed`,
`permissions_ok`, `permissions_sudo_denied`, `permissions_skipped`, `internal_error`.

Старый маршрут `POST /api/companies/:companyId/servers/ssh-dry-run` сохранён для
совместимости и возвращает прежнюю форму результата. Для новых клиентов используйте
типизированный маршрут onboarding.
