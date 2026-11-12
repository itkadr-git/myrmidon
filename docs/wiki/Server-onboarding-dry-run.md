# Server onboarding dry-run

To pre-check a server use `POST /api/companies/:companyId/servers/onboarding/dry-run`.
The check never creates or updates a server record. The request carries exactly one of
`auth.password` or `auth.privateKey`; secrets are used only in memory during the probes
and are never returned or logged.

Probes run in order: DNS, SSH authentication with a harmless `true` command, then
`sudo -n true`. The HTTP 200 result carries a stable `status` and `code` for each check
that ran. When a prerequisite fails, later probes are listed in `skippedChecks`.

Main codes: `dns_ok`, `dns_not_found`, `dns_timeout`, `dns_error`, `ssh_ok`,
`ssh_connection_refused`, `ssh_unreachable`, `ssh_timeout`, `ssh_auth_failed`,
`permissions_ok`, `permissions_sudo_denied`, `permissions_skipped`, `internal_error`.

The former `POST /api/companies/:companyId/servers/ssh-dry-run` endpoint remains as a
compatibility alias with the original response shape. New clients should use the typed
onboarding endpoint.
