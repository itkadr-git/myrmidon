## changelog-en

### Bots of agents that left the bot runtime are decommissioned (OPE-12654)

- An agent whose card moved from `hermes_gateway` to another adapter, or that was terminated,
  dropped out of every bot-container listing: its container kept running and its data
  directory stayed forever. The reconcile sweep now finds such bots every 10 minutes (from the
  card or its config history) and decommissions them: the container is stopped and deleted,
  with its leftovers, quota project and data directory.
- A bot is held, not removed, while its agent has a running heartbeat run, while its
  clone-hygiene report shows unpushed work (dirty tree, stash, operation in progress, commits on
  no remote), or when it is running without a usable report; the board log names the reason
  once (`bot_decommission_held`).
- dockergate: new route A22 `DELETE containers/myrmidon-bot-<K>?force=true&v=true&myrmidon-decommission=true`
  for the stopped main container only. It removes `<volumeRoot>/<K>` after the delete; this
  needs the volume root mounted read-write into the gate and the right to delete there — with
  today's read-only mount the delete succeeds, the directory stays and the gate logs
  `bot_data_remove_failed` (`read_only`).
- Terminating or deleting an agent decommissions its bot through the same route (the old
  cleanup's delete was always refused by the gate); a bot on a fleetd site still goes through
  the site's cleanup.

## changelog-ru

### Боты агентов, ушедших из среды ботов, выводятся из эксплуатации (OPE-12654)

- Агент, чья карточка перешла с `hermes_gateway` на другой адаптер, или уволенный агент выпадал
  из всех выборок контейнеров ботов: его контейнер продолжал работать, а каталог данных
  оставался навсегда. Теперь проход сверки раз в 10 минут находит таких ботов (по карточке или
  её истории настроек) и выводит их из эксплуатации: контейнер останавливается и удаляется
  вместе с остатками, проектом квоты и каталогом данных.
- Бот не удаляется, пока у агента есть выполняющийся прогон, пока отчёт гигиены клонов
  показывает неотправленную работу (незакоммиченные изменения, stash, незавершённая операция,
  коммиты вне удалённого репозитория) или пока он работает без пригодного отчёта; причина
  пишется в журнал доски один раз (`bot_decommission_held`).
- dockergate: новый маршрут A22 `DELETE containers/myrmidon-bot-<K>?force=true&v=true&myrmidon-decommission=true`
  только для остановленного основного контейнера. После удаления он удаляет `<volumeRoot>/<K>`;
  для этого корень томов должен быть смонтирован в шлюз на запись и шлюзу нужно право удалять
  там — при нынешнем монтировании только для чтения удаление проходит, каталог остаётся, шлюз
  пишет `bot_data_remove_failed` (`read_only`).
- Увольнение и удаление агента выводят его бота из эксплуатации тем же маршрутом (удаление в
  прежней очистке шлюз всегда отклонял); бот на площадке fleetd по-прежнему очищается её cleanup.
