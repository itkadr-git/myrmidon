## changelog-en

### A change of a bot's memory or pids limit reaches the running container without a restart (1.6.6 BOT-RESOURCES-APPLY)

- When only `HostConfig.Memory` / `HostConfig.PidsLimit` of a bot container
  differ from its spec (for example after `adapterConfig.container.memoryMb`
  is changed), the reconciler now applies the new limits with a live
  `docker update` (memory, memory-swap, pids) through a new dockergate route
  instead of recreating the container.
- A driver without live updates keeps the previous behaviour: the container is
  recreated. Any other kind of drift still recreates the container.

## changelog-ru

### Изменение лимита памяти или pids бота доходит до работающего контейнера без перезапуска (1.6.6 BOT-RESOURCES-APPLY)

- Если у контейнера бота от спецификации отличаются только `HostConfig.Memory`
  и/или `HostConfig.PidsLimit` (например, после смены
  `adapterConfig.container.memoryMb`), реконсилер применяет новые лимиты живым
  `docker update` (memory, memory-swap, pids) через новый маршрут dockergate, а
  не пересоздаёт контейнер.
- Драйвер без живого обновления ведёт себя как раньше: контейнер пересоздаётся.
  Любой другой дрейф по-прежнему приводит к пересозданию.
