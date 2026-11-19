# HA-GEO offline standby example

This is an offline preparation example, not a deployment or proof of replication,
RPO <= 300 seconds, or manual RTO <= 1800 seconds. It does not connect to any
host, provision a slot, initialise PGDATA, create standby.signal, or promote.
Do not apply it without a separate operator approval and change window.

T9 is the operational reference, not imported code: `scripts/myrmidon/standby/`
and `doc/runbooks/t9-center-standby.md` at main commit
`116d62336db8869200558daa1c3bd33bfc15b2b5`. T9 controls the physical
replica of the whole cluster (Board and Hindsight), including slot ownership,
recovery checks, and existing data safety. Never destroy promoted PGDATA or an
existing slot. T9's RPO is not the HA-GEO target.

## Inputs and preflight

Run `python3 scripts/ha-geo/standby/render.py INPUT.json > compose.json` only
with synthetic values during development. JSON output is also valid YAML.
A nonzero exit means discard output. All inputs are mandatory; unknown fields
are rejected. Input is operator-supplied, not discovered from a host:

- `primary_major`, `standby_major`: matching positive PostgreSQL major integers.
  The operator must independently verify the primary major and pinned image;
  the runtime guard also compares PG_VERSION and the actual postgres binary.
- `postgres_image`: `postgres@sha256:<64 lowercase hex>`; `app_image`:
  `ghcr.io/itkadr-git/myrmidon@sha256:<64 lowercase hex>`. The operator must
  separately verify provenance of the app digest from GitHub CI; digest syntax
  alone does not prove provenance or that the PostgreSQL image is suitable.
- `cpu`, `memory_mb`, `free_disk_mb`, and `required_cpu`,
  `required_memory_mb`, `required_disk_mb`: positive integers. The operator
  must measure available resources, specify requirements and disk reserve
  including base backup, WAL growth and headroom; these are assertions, not
  live measurements. CPU and memory apply separately to each service.
- `wal_keep_mb`, `max_slot_wal_keep_mb`: positive finite integer MB; slot
  retention must not be below WAL retention. Configure and monitor retention
  on the primary separately: settings in this offline standby example do not
  configure the primary or protect it against a stalled slot.
- `slot`, `primary_host`, `primary_port`, `replication_user`,
  `tls_server_name`: explicit identifiers; hostname and TLS server name must
  match, with `verify-full`. Confirm ownership of an existing slot before use.
- `ca_file`, `passfile`, `cert_file`, `key_file`: absolute paths to existing,
  nonempty readable files on the render host; only paths are emitted, never
  file contents. Use dedicated least-privilege files and suitable ownership
  and PostgreSQL passfile/private-key permissions. The operator must verify
  certificate validity, file readability by the container user, and actual
  TLS connectivity separately. Render does not parse these files.

Both services use opt-in profiles, do not restart automatically, publish no
ports, and have no routing, connector credentials or Docker socket. The cold
app additionally has no network, no DB credentials, and switches off scheduler
and backup; these switches are not a general outbound-traffic prohibition.
It is intentionally not a functional application until a later approved operator
procedure supplies connectivity and credentials. The standby volume is empty by
default: the startup guard refuses to start without standby.signal, matching
PG_VERSION and matching binary major. A separately approved operator procedure
must safely provision a physical base backup before any real start; rendering
alone neither starts nor validates it. No automatic promotion is provided.

## Verification and rollback

`python3 -m unittest discover -s scripts/ha-geo/standby -p 'test_*.py'`
uses synthetic files and no network. After preparation, remove only generated
local input/output files; do not delete secrets, slots, volumes, PGDATA or T9
assets. Any operational rollback, replication setup, traffic connection or
failover needs its own approved procedure. After any future start the operator
must independently verify `pg_is_in_recovery()`, replication and lag, primary
slot retention and disk headroom; this example is not evidence of those checks.
