## changelog-en

### Container axis of an isolation area (CONTAINER-SCOPE, part of 1.6.5)

- The area an agent belongs to is resolved once, in the shared module (BOT-DISK-F): the agent's own
  override, an explicit named group, a caste, a reporting subtree, a project, an installed catalog
  team, the whole company. This change consumes that resolution for **containers** and never
  re-implements it: the disk panel and the container panel below it in Instance settings always name
  the same area for the same agent.
- **One container per agent stays the default.** The owner can set a scope instance (a group, a
  caste, a subtree, a project, a catalog team, the company) to **one container for the area**: its
  members then run in one container with **one set of limits**. An instance left at *a container per
  agent* keeps private containers even if its disk instance is shared, and the reverse is possible —
  the two axes are set separately.
- **A change only changes what an agent resolves to**: nothing restarts by itself. The affected
  agents show **restart required** until the runtime reports the container it applied
  (`POST …/agents/:agentId/applied`); the marker names which container is expected.
- **Pausing one member of a shared container never stops the others.** The plan of an action
  (`POST …/agents/:agentId/actions`) says, per member, whether it stops, restarts or keeps running;
  a rollout of one bot inside a shared container does not take the area down.
- Limits are the container's, not the agent's: one shared container gets **one** memory and CPU
  ceiling, so a bot that eats memory puts the whole area under pressure — the screen shows the
  ceiling once per container. See `MYRMIDON_BOT_CONTAINER_MEMORY_MB` / `MYRMIDON_BOT_CONTAINER_CPUS`.
- API (board and instance admin for writes): `GET/PUT/DELETE …/companies/:id/container-scope`,
  `POST …/recompute`, `POST …/agents/:agentId/applied`, `POST …/agents/:agentId/actions`.
- DB: additive tables `myrmidon_container_settings`, `myrmidon_container_states`
  (migration 0299). No vendor table is touched and nothing is rewritten.

## changelog-ru

### Ось контейнеров области изоляции (CONTAINER-SCOPE, часть 1.6.5)

- Область агента разрешается один раз, в общем модуле (BOT-DISK-F): собственное переопределение
  агента, явная именованная группа, каста, поддерево подчинения, проект, установленная команда
  каталога, вся компания. Это изменение **использует** это разрешение для **контейнеров** и не
  повторяет его: панель диска и панель контейнеров под ней в настройках экземпляра всегда называют
  одну и ту же область для одного и того же агента.
- **По умолчанию остаётся один контейнер на агента.** Владелец может перевести экземпляр области
  (группу, касту, поддерево, проект, команду каталога, компанию) в режим **один контейнер на
  область**: тогда участники работают в одном контейнере с **одним набором лимитов**. Экземпляр,
  оставленный в режиме *по контейнеру на агента*, сохраняет личные контейнеры даже при общем диске,
  и наоборот — оси настраиваются отдельно.
- **Изменение меняет только то, к какой области агент относится**: сам ничего не перезапускается.
  Затронутые агенты показывают **нужен перезапуск**, пока рантайм не сообщит, какой контейнер он
  применил (`POST …/agents/:agentId/applied`); метка называет ожидаемый контейнер.
- **Пауза одного участника общего контейнера не останавливает остальных.** План действия
  (`POST …/agents/:agentId/actions`) говорит по каждому участнику, что он делает: останавливается,
  перезапускается или продолжает работать; выкат одного бота внутри общего контейнера не роняет
  область.
- Лимиты принадлежат контейнеру, а не агенту: общий контейнер получает **один** потолок памяти и
  CPU, поэтому бот, съевший память, нагружает всю область — экран показывает потолок один раз на
  контейнер. См. `MYRMIDON_BOT_CONTAINER_MEMORY_MB` / `MYRMIDON_BOT_CONTAINER_CPUS`.
- API (запись — доска и администратор экземпляра): `GET/PUT/DELETE …/companies/:id/container-scope`,
  `POST …/recompute`, `POST …/agents/:agentId/applied`, `POST …/agents/:agentId/actions`.
- БД: аддитивные таблицы `myrmidon_container_settings`, `myrmidon_container_states`
  (миграция 0299). Ни одна таблица вендора не тронута, ничего не перезаписывается.
