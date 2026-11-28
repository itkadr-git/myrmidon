---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_DEPLOY_UPDATE_CANARY_ENABLED` | OPE-12123 | `true` | Canary on/off switch for the auto-update service. A saved instance-settings value applies on the next tick without a restart | `false`/`0`/`no`/`off` disables the canary stage; the environment value is the forced override |
| `MYRMIDON_DEPLOY_UPDATE_CANARY_PERCENT` | OPE-12123 | `25` | Share of the fleet (0–100) that switches first during the canary stage of the auto-update service | An integer 0–100; the environment value is the forced override |

## settings-ru

| `MYRMIDON_DEPLOY_UPDATE_CANARY_ENABLED` | OPE-12123 | `true` | Главный переключатель канарейки сервиса автообновления. Сохранённое значение настроек инстанса применяется на следующем тике без перезапуска | `false`/`0`/`no`/`off` выключает канарейку; значение env — принудительный оверрайд |
| `MYRMIDON_DEPLOY_UPDATE_CANARY_PERCENT` | OPE-12123 | `25` | Доля флота (0–100), которая переключается первой на стадии канарейки сервиса автообновления | Целое 0–100; значение env — принудительный оверрайд |
