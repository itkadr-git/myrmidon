## changelog-en

### Fleet: site scheduler and bot move between sites (OPE-7652)

- Added the site scheduler lane (30 s): placement priority pin > affinity > capacity, a pending-placement queue with an alert instead of a silent local fallback, and low-to-P0 preemption behind a flag.
- Added the `fleet_moves` state machine (stop, snapshot, restore, host, reconcile, apiBaseUrl, quarantine) and `POST /fleet/bots/:key/move`.
- Added fleetd snapshot/restore/quarantine handlers (streaming tar.zst) and the `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, `myrmidon_fleet_moves` tables (migration 0401).

## changelog-ru

### Флот: планировщик площадок и перенос бота между площадками (OPE-7652)

- Добавлена lane планировщика площадок (30 с): приоритет размещения pin > affinity > capacity, очередь pending-размещения с алертом вместо тихого локального отката, вытеснение low → P0 за флагом.
- Добавлена state-machine `fleet_moves` (stop, snapshot, restore, host, reconcile, apiBaseUrl, quarantine) и `POST /fleet/bots/:key/move`.
- Добавлены ручки fleetd snapshot/restore/quarantine (потоковый tar.zst) и таблицы `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, `myrmidon_fleet_moves` (миграция 0401).
