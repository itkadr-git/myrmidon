## changelog-en

### 1.6.5 SWARM-PANEL-COOLING (OPE-6894): the swarm panel loses its dead cooling knobs, gains the real one, speaks Russian

- Removed: `pheromone.cooldownBaseMin` and `pheromone.cooldownCapMin` from the
  swarm-claim settings contract (`packages/shared/src/myrmidon-swarm-claim.ts`)
  and from the "Self-organization (swarm)" panel — no server code ever read
  them; the real cooling rule is `general.swarm` (the F-26 wake-task guard).
  A stored pre-1.6.5 `general.swarmClaim.pheromone` block that still carries
  the dead keys keeps parsing: they are stripped on read (mirrors the retired
  pilot keys), so no existing install loses its swarm settings.
- Added: a "Task cooling" block in the same panel section editing the one rule
  the board applies — `general.swarm.cooldownBaseMin` (default 30 min),
  `general.swarm.cooldownCeilingHours` (default 24 h) and the
  run-without-task gate. Empty fields mean the server default; saving PATCHes
  `general.swarm` through the instance-general settings API, so a change
  applies on the next wake without a restart. `updateGeneral` writes the
  stored document underneath, so `general.swarmClaim` survives the save (and
  a claim save keeps the cooling block) — pinned by
  `server/src/services/instance-settings-swarm-cooling.myrmidon.test.ts`.
- Localized: every string of the swarm-claim panel — the master switch, the
  pheromone mapping, the advanced extras, the change journal, the new cooling
  block, the live status line and the field-source badges — runs through the
  fork i18n catalog (`swarmClaim` namespace, en + ru). No hardcoded English
  remains in `SwarmClaimSettingsPanel.tsx`.
- How to check: Instance → General → "Self-organization (swarm)" in Russian:
  the pheromone grid has 8 fields (no cooldown pair); set the cooldown base to
  10, leave the ceiling empty, save, then look at the wake-task guard read
  back — `readSwarmSettings` returns 10 and a task whose stale run finished
  20 minutes ago wakes again (covered by
  `server/src/myrmidon/wake-task-guard.myrmidon.test.ts`).

## changelog-ru

### 1.6.5 SWARM-PANEL-COOLING (OPE-6894): панель роя теряет мёртвые поля остывания, получает настоящее и говорит по-русски

- Удалено: поля `pheromone.cooldownBaseMin` и `pheromone.cooldownCapMin` из
  контракта настроек захвата роя (`packages/shared/src/myrmidon-swarm-claim.ts`)
  и из панели «Самоорганизация (рой)» — сервер их нигде не читал; реальное
  правило остывания живёт в `general.swarm` (страж побудок F-26). Сохранённый
  до-1.6.5 блок `general.swarmClaim.pheromone` с мёртвыми ключами продолжает
  читаться: ключи отбрасываются при чтении (как ранее удалённые пилотные
  поля), настройки роя у существующих установок не теряются.
- Добавлено: блок «Остывание задач» в той же панели — настройка единственного
  действующего правила: `general.swarm.cooldownBaseMin` (по умолчанию 30 мин),
  `general.swarm.cooldownCeilingHours` (по умолчанию 24 ч) и шлагбаум
  «прогон только с задачей». Пустые поля — значение по умолчанию на сервере;
  запись идёт PATCH-ем `general.swarm` через API настроек экземпляра и
  применяется на следующей побудке без перезапуска. `updateGeneral` пишет
  поверх сохранённого документа, поэтому `general.swarmClaim` при сохранении
  остывания не теряется (и наоборот — сохранение захвата сохраняет остывание);
  закреплено тестом
  `server/src/services/instance-settings-swarm-cooling.myrmidon.test.ts`.
- Локализовано: все строки панели захвата роя — главный переключатель,
  феромоны, дополнительные поля, журнал изменений, новый блок остывания,
  строка состояния и метки источника значения — идут через каталог i18n
  форка (пространство имён `swarmClaim`, en + ru). Зашитого английского в
  `SwarmClaimSettingsPanel.tsx` не осталось.
- Как проверить: Instance → General → «Самоорганизация (рой)» на русском: в
  сетке феромонов 8 полей (пары остывания нет); выставьте базу остывания 10,
  потолок оставьте пустым, сохраните — `readSwarmSettings` вернёт 10, и
  задача после бесполезного прогона 20 минут назад снова будится (покрыто
  `server/src/myrmidon/wake-task-guard.myrmidon.test.ts`).
