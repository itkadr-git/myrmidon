# Zabbix guards

This directory is the reproducible source of truth for the ADM Zabbix item and trigger definitions requested by OPE-9868.

`guards.json` declares two Zabbix-agent items:

- `myrmidon.eng.idle.count`, guarded at `>=3` idle engineers;
- `vfs.fs.size[/srv/myrmidon-xfs,pfree]`, guarded at `<15` percent free.

The configuration is intentionally declarative. It does not execute a check, raise an alert, delete files, or remove existing host scripts. `owner` and `delivery` explicitly constrain handling to ADM and an operator-applied Zabbix rollout.

Validate the schema and acceptance thresholds with:

```sh
node docs/myrmidon/zabbix/guards.test.mjs
```

Rollout is ADM-only: an operator reviews this file, imports/applies the item and trigger definitions in Zabbix, verifies the target host group and expressions, and then enables the Zabbix configuration in the approved maintenance window. This change itself performs no live Zabbix action and must not be used as authorization to modify `myr-vm1`.
