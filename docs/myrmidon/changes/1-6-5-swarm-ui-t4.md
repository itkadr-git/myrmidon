## changelog-en

### Swarm self-organisation panel, supervisor overview and menu entries (1.6.5 SWARM-T4)

- The Instance → General section is now "Self-organisation (swarm)": one master switch, a live status line, a Pheromones block (priority seeds, aging, evaporation penalty, cooldown) and an Advanced block (lease TTL, per-agent ceiling, sweep interval).
- The pilot lists are gone: the master switch is the only gate. The environment overrides `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` and `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` are removed in 1.6.5 and are no longer read; remove them from the environment.
- Swarm supervisor: queue rows carry the effective pheromone strength, the nest agent and the waiting time; the overview adds free agents, recent matches, cooling tasks and warnings. The pilot-report route is removed.
- The menu lists "Swarm: queues" and "Foraging"; the streamlined sidebar keeps both visible.

## changelog-ru

### Панель самоорганизации роя, обзор супервизора и пункты меню (1.6.5 SWARM-T4)

- Раздел Instance → General теперь «Самоорганизация (рой)»: один главный переключатель, строка состояния с живыми числами, блок «Феромоны» (начальные веса приоритетов, старение, штраф испарения, остывание) и блок «Дополнительно» (TTL аренды, потолок на агента, интервал свипа).
- Пилотные списки убраны: единственный затвор — главный переключатель. Переопределения окружения `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` и `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` сняты в 1.6.5 и больше не читаются; уберите их из окружения.
- Супервизор роя: строки очереди несут эффективную силу феромона, агента гнезда и время ожидания; обзор добавляет свободных агентов, недавние сопоставления, остывающие задачи и предупреждения. Маршрут пилотного отчёта удалён.
- В меню — «Swarm: queues» и «Foraging»; упрощённый сайдбар оставляет оба видимыми.

## settings-en-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | removed in 1.6.5 | No longer read: the pilot role set was dropped with the pilot (SWARM-T4), the master switch is the only gate | Remove the variable from the environment; it has no effect |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | removed in 1.6.5 | No longer read: the pilot company set was dropped with the pilot (SWARM-T4), the master switch is the only gate | Remove the variable from the environment; it has no effect |
| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6-SWARM-CLAIM-B | removed in 1.6.5 | No longer read: the pilot report (and its baseline document) was removed with the pilot (SWARM-T4) | Remove the variable from the environment; it has no effect |

## settings-ru-replace

| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | снята в 1.6.5 | Больше не читается: набор пилотных ролей убран вместе с пилотом (SWARM-T4), единственный затвор — главный переключатель | Уберите переменную из окружения; она ни на что не влияет |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | снята в 1.6.5 | Больше не читается: набор пилотных компаний убран вместе с пилотом (SWARM-T4), единственный затвор — главный переключатель | Уберите переменную из окружения; она ни на что не влияет |
| `MYRMIDON_SWARM_PILOT_BASELINE_DOC` | 1.6-SWARM-CLAIM-B | снята в 1.6.5 | Больше не читается: пилотный отчёт (и его базовый документ) убраны вместе с пилотом (SWARM-T4) | Уберите переменную из окружения; она ни на что не влияет |
