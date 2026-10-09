## changelog-ru

### 1.6.5 F-26 SWARM (OPE-6608): отчёт пилота супервизора удалён

- Пилота роя больше нет, а с ним и отчёта «пилот против BASELINE»: удалены
  `swarm-claim-supervisor/pilot-report.ts`, маршрут
  `GET …/swarm-claim/supervisor/pilot-report`, переменная `MYRMIDON_SWARM_PILOT_BASELINE_DOC`,
  клиент `pilotReport` в `ui/src/api/swarmSupervisor.ts` и вкладка «Pilot vs BASELINE» на
  странице супервизора. Остаются обзор ролей, очереди, аренды и ручной релиз аренды.

## changelog-en

### 1.6.5 F-26 SWARM (OPE-6608): the supervisor's pilot report is removed

- There is no swarm pilot any more, and with it no "pilot vs BASELINE" report: removed
  `swarm-claim-supervisor/pilot-report.ts`, the route
  `GET …/swarm-claim/supervisor/pilot-report`, the variable `MYRMIDON_SWARM_PILOT_BASELINE_DOC`,
  the `pilotReport` client in `ui/src/api/swarmSupervisor.ts` and the "Pilot vs BASELINE" tab on
  the supervisor page. The role overview, the queues, the leases and the manual lease release stay.

## settings-ru-replace

| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6-SWARM-CLAIM-B | удалена | **Удалена в 1.6.5 (OPE-6608)**: отчёта пилота супервизора больше нет, код переменную не читает | Значение игнорируется |

## settings-en-replace

| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6-SWARM-CLAIM-B | removed | **Removed in 1.6.5 (OPE-6608)**: the supervisor's pilot report is gone and the code does not read the variable | The value is ignored |
