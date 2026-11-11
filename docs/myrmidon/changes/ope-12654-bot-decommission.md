## changelog-en

### Bots of agents that left the bot runtime are decommissioned (OPE-12654)

- An agent whose card moved from `hermes_gateway` to another adapter, or that was terminated,
  dropped out of every bot-container listing: its container kept running and its data
  directory stayed forever. The reconcile sweep now finds such bots every 10 minutes (from the
  card or its config history) and decommissions them: the container is stopped and deleted,
  with its leftovers.
- A bot is held, not removed, while its agent has a running heartbeat run, while its
  clone-hygiene report shows unpushed work (dirty tree, stash, operation in progress, commits on
  no remote), or when it is running without a usable report; the board log names the reason
  once (`bot_decommission_held`).
- dockergate: new route A22 `DELETE containers/myrmidon-bot-<K>?force=true&v=true&myrmidon-decommission=true`
  for the stopped main container only. Stopped leftovers (`.next`, helper) go first, then the
  main container without a replacement. The gate runs as uid 65532 with the volume root
  read-only, so it does not remove `<volumeRoot>/<K>`: it logs `bot_data_left_for_host_gc`,
  and the quota project waits too (`disk_project_still_has_directory`,
  `quota_left_for_host_gc`).
- The host GC pass (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) removes the data
  directory instead: 24 h after the bot's last change, and only when no `myrmidon-bot-<key>`
  container of any state remains, the board lists no `hermes_gateway` card for the agent (it
  moved away, was terminated or deleted), no heartbeat run of the agent is `running`, and no
  git worktree under the directory holds unpushed work (uncommitted edits, stash, an
  operation in progress, commits on no remote). `.next` and `.helper` directories are not
  worktrees and are not touched. After the removal the pass clears the quota project's
  `/etc/projid` and `/etc/projects` entries and its limits. An unreachable docker daemon or
  board keeps the directories (fail-closed); a directory with unpushed work is held and
  journalled loudly (`bot-data-held-unpushed`).
- Terminating or deleting an agent decommissions its bot through the same route (the old
  cleanup's delete was always refused by the gate); a bot on a fleetd site still goes through
  the site's cleanup.

## changelog-ru

### Боты агентов, ушедших из среды ботов, выводятся из эксплуатации (OPE-12654)

- Агент, чья карточка перешла с `hermes_gateway` на другой адаптер, или уволенный агент выпадал
  из всех выборок контейнеров ботов: его контейнер продолжал работать, а каталог данных
  оставался навсегда. Теперь проход сверки раз в 10 минут находит таких ботов (по карточке или
  её истории настроек) и выводит их из эксплуатации: контейнер останавливается и удаляется
  вместе с остатками.
- Бот не удаляется, пока у агента есть выполняющийся прогон, пока отчёт гигиены клонов
  показывает неотправленную работу (незакоммиченные изменения, stash, незавершённая операция,
  коммиты вне удалённого репозитория) или пока он работает без пригодного отчёта; причина
  пишется в журнал доски один раз (`bot_decommission_held`).
- dockergate: новый маршрут A22 `DELETE containers/myrmidon-bot-<K>?force=true&v=true&myrmidon-decommission=true`
  только для остановленного основного контейнера. Сначала удаляются остановленные остатки
  (`.next`, helper), затем основной контейнер без замены. Шлюз работает под uid 65532 с корнем
  томов только для чтения, поэтому `<volumeRoot>/<K>` он не удаляет: он пишет
  `bot_data_left_for_host_gc`, и проект квоты тоже ждёт (`disk_project_still_has_directory`,
  `quota_left_for_host_gc`).
- Каталог данных вместо шлюза удаляет проход хозяйственной уборки на хосте
  (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`): через 24 ч после последнего изменения
  бота — и только когда не осталось ни одного контейнера `myrmidon-bot-<key>` в любом
  состоянии, на доске нет карточки `hermes_gateway` этого агента (он ушёл, уволен или удалён),
  у агента нет прогона в статусе `running` и ни один git-worktree в каталоге не держит
  неотправленную работу (незакоммиченные правки, stash, незавершённая операция, коммиты вне
  удалённых репозиториев). Каталоги `.next` и `.helper` worktree не являются и не
  затрагиваются. После удаления проход снимает записи проекта квоты из `/etc/projid` и
  `/etc/projects` и его лимиты. Недоступный демон docker или доска оставляют каталоги на месте
  (fail-closed); каталог с неотправленной работой удерживается и громко пишется в журнал
  (`bot-data-held-unpushed`).
- Увольнение и удаление агента выводят его бота из эксплуатации тем же маршрутом (удаление в
  прежней очистке шлюз всегда отклонял); бот на площадке fleetd по-прежнему очищается её cleanup.
