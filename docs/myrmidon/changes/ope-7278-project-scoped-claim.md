---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Automatic task taking is project-scoped (PROJECT-SCOPED-CLAIM)

- The swarm matcher (a ready task, a free agent, the periodic pass), the claim
  API's role queue now hand a task that belongs to a project
  only to a member of that project: its lead, an agent with a joined
  `project_memberships` row, or an agent nested in it (`agent_nests`). A task without a project stays open to the
  company, and a task already assigned to an agent (by hand) is never gated, and idle pickup, which only works assigned tasks, is not project-scoped.
- `GET /companies/:id/agents` carries an optional `projectIds` per agent (lead
  projects plus joined memberships), so the board UI can filter the roster by
  project on the client.
- Child tasks already inherit the parent's project when none is given
  (`createChild`, and the issue create route); this change leaves that as is.

## changelog-ru

### Автоматический захват задач ограничен проектом (PROJECT-SCOPED-CLAIM)

- Матчер роя (готовая задача, свободный агент, периодический проход), очередь
  роли в claim API отдают задачу проекта только участнику этого
  проекта: лиду, агенту с записью `project_memberships` в состоянии
  `joined` или агенту с гнездом в проекте (`agent_nests`). Задача без проекта по-прежнему открыта для всей компании, а
  назначенная вручную не фильтруется (idle pickup берёт уже назначенное агенту и проектом не ограничен).
- `GET /companies/:id/agents` отдаёт необязательное `projectIds` у каждого
  агента (проекты, где он лид, вступления `joined` и гнёзда) — UI доски фильтрует
  ростер по проекту на клиенте.
- Подзадачи и так наследуют проект родителя, если свой не задан
  (`createChild` и маршрут создания задачи); это изменение их не трогает.

## divergence

| PROJECT-SCOPED-CLAIM | Автоматический захват ограничен членством в проекте: задачу проекта матчер роя, очередь роли claim API отдают только лиду проекта или агенту с `project_memberships.state = 'joined'` (user_id — агент той же компании) или с записью `agent_nests` (решение ADM 18.10); задача без проекта открыта компании, назначенная вручную не фильтруется (idle pickup берёт уже назначенное агенту и проектом не ограничен). Ростер `GET /companies/:id/agents` отдаёт `projectIds` | `server/src/myrmidon/project-membership.ts`, `server/src/myrmidon/swarm-claim/matcher.ts`, `server/src/myrmidon/swarm-claim/queue.ts`, `server/src/services/agents.ts`, `server/src/myrmidon/bot-containers/scope-wiring.ts` (метка `myrmidon(1.6.6 PROJECT-SCOPED-CLAIM)`) | OPE-7276/7278: боты чужого проекта (bbq-*) захватывали задачи проекта «Разработка инструментов» | `server/src/__tests__/swarm-project-scope-embedded.myrmidon.test.ts` | Никогда, наше поведение. Снятие: убрать проверки с меткой `myrmidon(1.6.6 PROJECT-SCOPED-CLAIM)` и модуль `project-membership.ts` | (этот PR) |
