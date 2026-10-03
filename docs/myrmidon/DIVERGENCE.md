# Divergence Log

This document tracks deviations from the original design as the system evolves.

## Changes

### 1.6.1 - BOT-DISK A — жизненный цикл черновиков бота (OPE-4021)
- Added bot disk lifecycle management system
- New API endpoint: `/api/myrmidon/bot-disk` for managing lifecycle settings
- New settings: `lifecycle.enabled`, `lifecycle.idleTtlMs`, `lifecycle.defaultIdleTtlMs`
- New attention source kind: `bot_disk_lifecycle`
- Integration with maintenance tick to periodically clean up stale bot volumes
- Default idle TTL set to 6 hours
- Files affected: 
  - `server/src/myrmidon/bot-containers/draft-lifecycle.ts`
  - `server/src/myrmidon/bot-containers/lifecycle-settings.ts`
  - `server/src/routes/myrmidon-bot-disk.ts`
  - `server/src/myrmidon/maintenance/index.ts`
  - `packages/shared/src/types/attention.ts`
  - `server/src/services/attention.ts`

// myrmidon(OPE-4021): Documented divergence for bot disk lifecycle feature