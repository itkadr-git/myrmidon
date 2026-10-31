---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## settings-en

| `MYRMIDON_BOT_STATE_DIR` | IDLE-STOP-STATE (OPE-8446) | the board instance root | Directory on the board's own data volume for driver-owned state (idle-stopped marks), so the board never writes into the host's `MYRMIDON_BOT_VOLUME_ROOT` | Set only to move the state elsewhere on the board volume |
