# HA-GEO inventory (partial implementation)

This is not a readiness check. The default command does not connect to a database
or a remote host. It reports unmeasured fields as unknown and exits 2 while any
required area remains unknown. Do not place passwords or connection strings in
arguments. PostgreSQL access uses a local Unix socket only, a clean environment,
no password file, no prompt, and a fixed read-only query. Permission errors are
reported without server error text. Operators must obtain separate approval
before running on any production host.

After approval, on the approved host, from the repository root:

```
python3 scripts/ha-geo/inventory/collector.py --help
python3 scripts/ha-geo/inventory/collector.py
python3 scripts/ha-geo/inventory/collector.py --socket /var/run/postgresql --database DATABASE_NAME --user READ_ONLY_USER
```

Replace the socket directory, database and user with the approved values. The
account must be permitted to connect without a password prompt and to read the
listed statistics. No credentials are passed through the environment. The
collector does not enable TLS for a Unix socket; it does not assess remote TLS.
The disk measurement defaults to `/`, not necessarily the database volume. Pass
`--disk-path /APPROVED/DATABASE/VOLUME` to measure an approved local volume;
the supplied path is not included in the JSON. The collector
checks whether the `chromium`, `openssl` and `sshd` executables are present;
this does not identify the CI profile or configured TLS. Python's linked OpenSSL
version and TLS 1.2/1.3 feature flags describe local client-library capabilities,
not the server's network TLS configuration. If sshd is available,
`sshd -T` reports default password, public-key and keyboard-interactive settings.
Only those booleans are retained; other output and errors are suppressed. This
does not evaluate Match rules, confirm service health, or establish access for a
specific user or source address. Inaccessible configuration remains unknown.
The CI/browser section also reports the total size of `/dev/shm` when available;
this is the current mount's capacity, not proof of the CI job configuration.
When accessible, cgroup v2 CPU quota and memory limit describe this process's
own cgroup only; null means unavailable or unlimited, not a CI job limit.
Time synchronization is reported when `timedatectl` exposes it. Backup configuration
is unknown; executable availability for pg_basebackup, pgbackrest and barman
does not establish that backups are configured or healthy. The CI profile also
reports node and pnpm executable availability, not CI configuration. Archive mode,
timeout, last successful archive time and failed archive
count are PostgreSQL facts, not proof of a backup. `ssl_configured` reports the
server setting; a socket connection does not prove network TLS works.
These limitations mean exit 2 remains expected even when PostgreSQL succeeds.
`lag_bytes` is replay byte lag on a standby. `lag_seconds` is the age of the last
replayed transaction, not a reliable RPO: it also increases on an idle primary.
Do not treat a null lag as zero or this output as proof of a working standby.

Run isolated fixture checks with `python3 -m unittest discover -s scripts/ha-geo/inventory -v`.
