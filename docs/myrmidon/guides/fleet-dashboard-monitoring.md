# Fleet dashboard data: VictoriaMetrics + Zabbix connections, snapshot API, selfcheck (1.6.6 MONITORING C)

> Russian version: [fleet-dashboard-monitoring.ru.md](fleet-dashboard-monitoring.ru.md)

The fleet dashboard data API (part C of the MONITORING track) gives the board
one aggregated snapshot of the fleet the deployment runs on: the hosts, the
bot containers, the LiteLLM proxy and the build VPS. The numbers come from
two external sources — VictoriaMetrics (node_exporter PromQL) and Zabbix
(`host.get` / `item.get`) — and this guide covers how to connect them, what
the dashboard endpoint answers, and how to read the selfcheck. The fleet
screen itself is a later part of the track; everything here is the API the
screen and the operator scripts read.

Both sources are read-only by construction: the VM client issues instant
PromQL queries (`/api/v1/query`) and nothing else; the Zabbix client calls
only `apiinfo.version`, `host.get` and `item.get`. The board never writes to
either system.

## Connection settings

The connection settings live in the instance settings of the board (one
document per company, the same pattern the maintenance and alerts settings
use) and are managed through the API:

| Method | Path | Who | What it does |
|---|---|---|---|
| `GET` | `/api/myrmidon/monitoring` | board user | Reads the connection settings of the company (pass `?companyId=` when the actor belongs to several) |
| `PATCH` | `/api/myrmidon/monitoring` | instance admin | Updates the settings; the patch is an additive merge — fields absent from the request keep their stored values |

The settings document:

| Field | Default | What it does |
|---|---|---|
| `vmUrl` | unset | Base URL of VictoriaMetrics, e.g. `http://vm:8428`. Unset — the VM source reports `not_configured` |
| `vmTokenRef` | unset | Read-token reference for VM: `env:<NAME>` or `file:<PATH>` |
| `zabbixUrl` | unset | Zabbix API endpoint (the `api_jsonrpc.php` URL). Unset — the Zabbix source reports `not_configured` |
| `zabbixTokenRef` | unset | Read-token reference for the Zabbix API: `env:<NAME>` or `file:<PATH>` |
| `vmJobSelector` | `node` | PromQL label value that selects the fleet node_exporter jobs (used as `job=~"<value>"`) |
| `zabbixHostGroups` | `[]` | Zabbix host groups the dashboard reads; empty means all monitored hosts |
| `timeoutMs` | `10000` | Per-source request timeout, 500–60000 ms |

Token references, not token values. The settings store only `env:<NAME>`
(the name of an environment variable of the board server process) or
`file:<PATH>` (a file readable by the board, for example a Docker secret).
The value is resolved in memory on each request and is never stored in the
settings, never returned by the API and never logged. A reference that
resolves to an empty value counts as a configuration error. Leave the
reference unset when the source needs no auth — it is then queried without a
token.

An unconfigured source is not an error: with `vmUrl` unset the VM source
answers `not_configured`, and the dashboard still serves whatever Zabbix
returned (and the other way round).

## The dashboard snapshot

`GET /api/myrmidon/monitoring/dashboard` (board user) answers one JSON
document:

| Field | Content |
|---|---|
| `ok` | `true` when every configured source answered |
| `generatedAt` | ISO instant of the snapshot |
| `sources` | Per-source probe: `{name, ok, latency_ms, error}` for `victoriametrics` and `zabbix`; `error` is a machine-readable class (`not_configured`, `http_502`, `timeout`, `request_failed`) with no URL or token detail |
| `hosts` | One card per fleet host: `name`, `origin` (`victoriametrics` / `zabbix` / `none`), `cpuPercent`, `memoryPercent`, `swapPercent`, `diskPercent`, `ageSec` (seconds since the freshest sample), `runbookKey` |
| `containers` | Bot containers from cAdvisor (when VM has them): `name`, `cpuPercent`, `memoryBytes`, `state` |
| `litellm` | LiteLLM proxy rollup when VM exports it: `ok`, `rps`, `latencyP95Sec`; otherwise `null` |
| `vps` | Build VPS rollup (the host labeled as the build host): `cpuPercent`, `memoryPercent`, `diskPercent`; otherwise `null` |

How the two sources merge:

- Host readings come from VictoriaMetrics first (node_exporter PromQL,
  selected by `vmJobSelector`). Zabbix fills in the hosts VM does not see; a
  host known to both keeps the VM numbers (`origin: "victoriametrics"`).
- A source that fails degrades in place: the dashboard still answers with
  whatever the other source returned, and the failed source is visible in
  `sources` with its error class.
- Container, LiteLLM and VPS sections are best-effort on top of VM: when
  those queries fail, the host cards stay and the section is empty.

The `runbookKey` of a host card is the key of the alert-recovery runbook the
"create task with runbook" action of the fleet screen uses to file the
recovery task: an unreachable
host maps to `host-unreachable` (its runbook lives in
[runbooks/host-unreachable.md](../runbooks/host-unreachable.md)), a host at
90 % or more on any of CPU / memory / swap / disk maps to `host-saturation`,
and a host with the root filesystem at 85 % or more maps to
`host-disk-pressure`. A healthy host carries `null`.

## The selfcheck

`GET /api/myrmidon/monitoring/dashboard/selfcheck` (board user) probes every
configured source with one cheap read — `up` against VM, `apiinfo.version`
against Zabbix — and answers:

```json
{
  "ok": true,
  "vm_ok": true,
  "zabbix_ok": true,
  "sources": [
    { "name": "victoriametrics", "ok": true, "latency_ms": 12, "error": null },
    { "name": "zabbix", "ok": true, "latency_ms": 44, "error": null }
  ]
}
```

Reading it:

- The `sources` list always carries both sources, configured or not, so the
  fleet screen can render a status card per source.
- `ok` is `true` only when at least one source is configured and every
  configured source answered; a source left unset (`not_configured`) does
  not break the verdict.
- The answer contains no secret material — only names, booleans and
  latencies — so it is safe to poll from dashboards and scripts.

## Settings reference

The variables of this module are listed in the
[SETTINGS.md](../SETTINGS.md) section «1.6.6 — MONITORING C: fleet dashboard
connections (VictoriaMetrics + Zabbix)»
([Russian version](../SETTINGS.ru.md)); the release notes entry is in
[CHANGELOG.md](../CHANGELOG.md). For the alert webhooks of the same
monitoring track (Zabbix and Alertmanager alerts becoming board issues) see
the «1.6.6 — ALERTS» section of the same files.
