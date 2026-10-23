---
divergence-section: Трек 1 — платформа
---

## changelog-en

### REMOTE-SITES-T4: remote site health monitor and failover policy (OPE-7651)

- New site health monitor polls each fleet site, runs the shared health reducer
  and persists its snapshot. On a drain intent it fences the site before
  anything else; on a failover intent it asks the failover orchestrator to move
  the site's bots. A site that answers again stays unreachable until an
  operator re-enables it.
- The failover orchestrator moves each unpinned bot once to a reserve site
  through the existing move service and marks pinned bots unavailable instead of
  moving them.

## changelog-ru

### REMOTE-SITES-T4: монитор здоровья площадок и политика failover (OPE-7651)

- Новый монитор здоровья опрашивает площадки флота, прогоняет общий reducer и
  сохраняет его снимок. По намерению drain сначала отгораживает площадку, по
  намерению failover просит оркестратор перенести её ботов. Вернувшаяся площадка
  остаётся unreachable, пока оператор не включит её снова.
- Оркестратор failover переносит каждого незакреплённого бота один раз на
  резервную площадку через существующий сервис переезда, закреплённых помечает
  недоступными и не переносит.
