## changelog-en

### Fleet control of bots on remote sites works on a split board (OPE-12032)

- On a board running `processes.mode = split`, `POST /api/myrmidon/fleet/bots/:key/restart`, `…/stop`
  and `GET …/logs` for a bot on a registered, healthy site answered `502 … has no active mTLS client
  transport; register valid certificate, key, and CA`. The site mTLS client manager is built by
  `startBotContainers`, which only the worker runs, so an api process had no manager (and no
  bot-container runtime) even with `MYRMIDON_SITE_HEALTH=1`.
- The api process now forwards the fleet control routes of bots and sites to the worker through the
  single-route proxy (the `bot_container` group): `/api/myrmidon/fleet/bots/:key/(restart|stop|logs)`,
  `/api/myrmidon/fleet/sites/overview`, `/api/myrmidon/fleet/sites/:name[/bots|/drain|/resume]` and
  `/api/fleet/bots/:key/(move|logs)`. The worker holds the one client manager and reaches the site's
  fleetd through its mutual-TLS transport. The registry list `GET /api/myrmidon/fleet/sites`, the
  enroll/list/delete routes of `/api/companies/:id/fleet/sites` and the console routes stay with the
  api process (database only).
- Unchanged: with the `singletonProxy` setting off, or on a single-process board, the process that
  serves the route answers from its own manager, and without one the answer is still the clear 502
  naming the site.

## changelog-ru

### Управление ботами на удалённых площадках работает на split-доске (OPE-12032)

- На доске с `processes.mode = split` запросы `POST /api/myrmidon/fleet/bots/:key/restart`,
  `…/stop` и `GET …/logs` для бота зарегистрированной здоровой площадки отвечали
  `502 … has no active mTLS client transport; register valid certificate, key, and CA`. Менеджер
  клиентских mTLS-подключений площадок создаёт `startBotContainers`, а он запускается только в
  worker, поэтому в api-процессе не было ни менеджера, ни рантайма bot-container даже при
  `MYRMIDON_SITE_HEALTH=1`.
- Теперь api-процесс пересылает маршруты управления ботами и площадками на worker через прокси
  одиночных маршрутов (группа `bot_container`):
  `/api/myrmidon/fleet/bots/:key/(restart|stop|logs)`, `/api/myrmidon/fleet/sites/overview`,
  `/api/myrmidon/fleet/sites/:name[/bots|/drain|/resume]` и `/api/fleet/bots/:key/(move|logs)`.
  У worker единственный менеджер клиентов, он обращается к fleetd площадки по её mTLS-транспорту.
  Список реестра `GET /api/myrmidon/fleet/sites`, маршруты заведения/списка/удаления
  `/api/companies/:id/fleet/sites` и маршруты консоли остаются в api-процессе (только база).
- Без изменений: при выключенной настройке `singletonProxy` и на однопроцессной доске маршрут
  обслуживает тот процесс, который его принял, по своему менеджеру; без менеджера ответ прежний —
  понятный 502 с названием площадки.
