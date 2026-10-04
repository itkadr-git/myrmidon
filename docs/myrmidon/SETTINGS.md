# Myrmidon Settings

This document describes the various settings available for the Myrmidon system.

## Bot Disk Settings

### Lifecycle Settings
- `lifecycle.enabled`: Boolean to enable/disable bot disk lifecycle management
- `lifecycle.idleTtlMs`: Time in milliseconds after which idle bot disks are cleaned up (minimum 5 minutes, maximum 30 days)
- `lifecycle.defaultIdleTtlMs`: Default idle TTL in milliseconds

### Quota Settings
- `quota.defaultMb`: Default disk quota in MB for bots
- `quota.perBotMb`: Disk quota in MB per individual bot

### Shared Settings
- `shared.enabled`: Boolean to enable/disable shared disk space

### Host Signal Settings
- `hostSignal.thresholdPct`: Threshold percentage for host disk usage alerts (0-100)
- `hostSignal.enabled`: Boolean to enable/disable host signal monitoring

These settings can be adjusted via the API endpoints without requiring a system restart.

// myrmidon(OPE-4021): Added bot disk lifecycle settings