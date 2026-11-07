## changelog-en

### The worker's loopback listener follows MYRMIDON_WORKER_HOST/PORT; the T1-T8 stand boots a worker for T3

- The worker opened its internal loopback listener on a fixed 127.0.0.1:3101
  while the api side (single-route proxy) and the launch map of the
  orchestrator already used `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT`.
  Both sides now resolve the address through one function, so a launch map
  with a non-default worker port no longer leaves the api dialing a closed port.
- Test stand: the bot-container route is a single route that an api process
  forwards to the worker, so T3 now runs against a real worker (own free
  loopback port) and checks the worker's `409 bot_containers_disabled` arriving
  through the api processes.

## changelog-ru

### Loopback-слушатель worker следует MYRMIDON_WORKER_HOST/PORT; стенд T1-T8 поднимает worker для T3

- Worker открывал внутренний loopback-слушатель на фиксированном 127.0.0.1:3101,
  а сторона api (прокси одиночных маршрутов) и карта запуска оркестратора уже
  использовали `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT`. Теперь обе
  стороны берут адрес из одной функции: карта запуска с нестандартным портом
  worker больше не оставляет api стучаться в закрытый порт.
- Тестовый стенд: маршрут bot-container — одиночный, api пересылает его на
  worker, поэтому T3 идёт против настоящего worker (свой свободный loopback-порт)
  и проверяет, что `409 bot_containers_disabled` от worker приходит через api.
