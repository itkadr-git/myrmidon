# Server onboarding dry-run

The current endpoint is `POST /api/companies/:companyId/servers/onboarding/dry-run`.
It is a read-only pre-registration probe and never creates or updates a server record.
The request contains exactly one of `auth.password` or `auth.privateKey`; credentials are
used only in memory by the probes and are never returned or logged.

The probes run in order:

1. DNS resolution (`dns_*`)
2. SSH authentication and a harmless `true` command (`ssh_*`)
3. Passwordless sudo with `sudo -n true` (`permissions_*`)

A failed prerequisite causes later probes to appear in `skippedChecks`. The HTTP response
is 200 for probe results; inspect each check's stable `status` and `code`.

Stable codes include `dns_ok`, `dns_not_found`, `dns_timeout`, `dns_error`, `ssh_ok`,
`ssh_connection_refused`, `ssh_unreachable`, `ssh_timeout`, `ssh_auth_failed`,
`permissions_ok`, `permissions_sudo_denied`, `permissions_skipped`, and `internal_error`.
The response contains only `dryRun`, `checks`, `skippedChecks`, `ok`, and `durationMs`.

The former `POST /api/companies/:companyId/servers/ssh-dry-run` endpoint remains available
as a compatibility alias for clients using the original private-key-only response shape.
New clients should use the typed onboarding endpoint.
