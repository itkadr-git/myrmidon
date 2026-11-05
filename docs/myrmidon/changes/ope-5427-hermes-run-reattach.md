## changelog-en

### HERMES-RUN-REATTACH: gateway runs survive a board restart

- Before orphaned runs are reaped, the reattach sweep uses the gateway run ID
  saved with the heartbeat run to resume an in-flight `hermes_gateway` run.
  Its result remains visible on the board rather than being lost or restarted.
- Gateway HTTP 429 means busy, not a terminal failure: `transient_upstream`
  keeps the agent idle for a bounded retry, honoring `Retry-After` for up to
  eight attempts within one hour. Cancelling the board run sends
  `POST /v1/runs/{id}/stop` to the gateway.
- To verify, restart the board while a gateway run is active; confirm the run
  completes and its result is visible on the board.

## changelog-ru

### HERMES-RUN-REATTACH: прогоны шлюза переживают рестарт доски

- До уборки осиротевших прогонов sweep переподхвата использует сохранённый в
  heartbeat run ID шлюзового прогона, чтобы продолжить активный
  `hermes_gateway`-прогон. Его результат остаётся виден на доске, а прогон
  не теряется и не запускается повторно.
- HTTP 429 от шлюза означает «занят», а не окончательный сбой:
  `transient_upstream` оставляет агента свободным до ограниченного повтора
  с учётом `Retry-After` — до восьми попыток в пределах часа. Отмена
  прогона на доске отправляет шлюзу `POST /v1/runs/{id}/stop`.
- Проверка: перезапустить доску посреди активного шлюзового прогона и
  убедиться, что он завершился, а результат виден на доске.
