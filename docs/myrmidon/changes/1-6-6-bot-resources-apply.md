## changelog-en

### A change of a bot's memory or pids limit reaches the running container without a restart (1.6.6 BOT-RESOURCES-APPLY, OPE-10565)

- When `adapterConfig.container.memoryMb`, `cpus`, or `pidsLimit` are changed in the
  card, the reconciler updates container resources as a single coordinated operation:
  it updates dockergate's `bots[]` configuration and runtime ceilings via dockergate
  route A20 (`PUT /containers/<name>/config/update`), validating against instance platform
  ceilings with atomic reload, then applies the limits to the running container via
  live `docker update` (route A18, memory, memory-swap, pids) without container restart.
- If requested limits exceed platform ceilings, dockergate rejects the update with a
  clear error (`requested resource limits exceed platform ceiling`), keeping the container
  running with its existing limits.
- A driver without live updates keeps the previous behaviour: the container is
  recreated. Any other kind of drift still recreates the container.

## changelog-ru

### Изменение лимита памяти или pids бота доходит до работающего контейнера без перезапуска (1.6.6 BOT-RESOURCES-APPLY, OPE-10565)

- При изменении в карточке `adapterConfig.container.memoryMb`, `cpus` или `pidsLimit`
  реконсилер применяет новые лимиты как единую операцию: обновляет конфигурацию `bots[]`
  и потолки в памяти dockergate через маршрут A20 (`PUT /containers/<name>/config/update`)
  с проверкой потолков площадки и атомарной перезагрузкой, а затем применяет лимиты к
  работающему контейнеру через живой `docker update` (маршрут A18, memory, memory-swap, pids)
  без перезапуска контейнера. Ручная правка `dockergate/config.json` больше не требуется.
- При запросе лимитов выше потолка площадки dockergate возвращает понятную ошибку
  (`requested resource limits exceed platform ceiling`), а контейнер продолжает работу
  со старыми лимитами.
- Драйвер без живого обновления ведёт себя как раньше: контейнер пересоздаётся.
  Любой другой дрейф по-прежнему приводит к пересозданию.
