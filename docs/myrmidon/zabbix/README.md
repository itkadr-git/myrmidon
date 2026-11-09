# Zabbix guards

This directory is the reproducible source of truth for the ADM Zabbix item and trigger definitions requested by OPE-9868 and OPE-11780.

## Overview

`guards.json` defines declarative Zabbix-agent items and triggers, providing standard vendor monitoring to replace ad-hoc host watchdogs on vm-core per Alex's mandate (OPE-10993 / OPE-11780).

### Monitored items

- `myrmidon.eng.idle.count`: idle engineer count, guarded at `>=3` (OPE-9868);
- `vfs.fs.size[/srv/myrmidon-xfs,pfree]`: `/srv/myrmidon-xfs` free percentage, warning at `<15%` (OPE-9868) and critical at `<10%` (OPE-11780, Alex 10% threshold rule);
- `vfs.fs.size[/,pfree]`: root filesystem free percentage, critical at `<10%` (replaces `disk-watch-board`);
- `log[/var/log/kern.log,...]`: kernel OOM-killer detection (replaces `oom-watch`);
- `vfs.dir.size[/root/.cache]`: build cache presence on vm-core (replaces `vmcore-buildcache-guard`; builds forbidden on vm-core);
- `systemd.failed.count`: failed systemd services/timers count (replaces `vmcore-timers-watch`);
- `agent.ping`: Zabbix agent reachability ping (replaces `vmcore-stub-watch`).

### Host Watchdog Decommission Mapping (OPE-11780)

All five host watchdogs are retired once ADM applies and verifies the Zabbix templates on vm-core:

| Host Watchdog | Script / Timer | Replacement Trigger | Decommission Action |
|---|---|---|---|
| `oom-watch` | `/usr/local/sbin/oom-watch.sh` (`oom-watch.timer`) | `kernel-oom-detected` (`log[...]`) | `systemctl disable --now oom-watch.timer oom-watch.service` |
| `disk-watch-board` | `/usr/local/bin/disk-watch-board.sh` (`disk-watch-board.timer`) | `myrmidon-xfs-critical`, `root-low-critical` (10% threshold) | `systemctl disable --now disk-watch-board.timer disk-watch-board.service` |
| `vmcore-buildcache-guard` | `/usr/local/sbin/vmcore-buildcache-guard.sh` (`vmcore-buildcache-guard.timer`) | `vmcore-buildcache-detected` (`vfs.dir.size[...]`) | `systemctl disable --now vmcore-buildcache-guard.timer vmcore-buildcache-guard.service` |
| `vmcore-timers-watch` | `/usr/local/sbin/vmcore-timers-watch.sh` (`vmcore-timers-watch.timer`) | `systemd-timers-failed` (`systemd.failed.count`) | `systemctl disable --now vmcore-timers-watch.timer vmcore-timers-watch.service` |
| `vmcore-stub-watch` | `/usr/local/sbin/vmcore-stub-watch.sh` (`vmcore-stub-watch.timer`) | `agent-unavailable` (`nodata(/agent.ping,3m)=1`) | `systemctl disable --now vmcore-stub-watch.timer vmcore-stub-watch.service` |

## Validation

Validate the schema, acceptance thresholds, and decommission targets with:

```sh
node docs/myrmidon/zabbix/guards.test.mjs
```

## Rollout and Safety Contract

The configuration is intentionally declarative:
- It does not execute a check, raise an alert, delete files, or modify host scripts directly.
- Rollout is ADM-only: an operator reviews `guards.json`, applies item/trigger definitions in Zabbix, verifies the host groups and active checks on vm-core, and only then disables the retired host timers.
