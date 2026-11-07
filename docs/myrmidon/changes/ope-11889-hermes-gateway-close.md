## changelog-en

### HERMES-GATEWAY-CLOSE: the board frees the gateway slot of every run it finishes (OPE-11889)

- A `hermes_gateway` run keeps a slot in the bot gateway's `max_concurrent_runs`
  until the remote run ends. Before, the board stopped the remote run only when an
  operator cancelled an unsupervised run, so runs the board ended any other way
  (the execution-control deadline, a stale or `process_lost` reap, an adapter
  failure that left the remote run alive) held their slot until the gateway's own
  timeout, and bots answered `Too many concurrent runs (max 8)`.
- Now every terminal status (`succeeded`, `failed`, `timed_out`, `cancelled`,
  `interrupted`) closes the remote run: the central status writers and the
  execution-control reconciliation do it at once, and a periodic sweep
  (every 60 s, runs changed within the last 2 h) covers every other writer and a
  crash between the terminal write and the close. The board probes
  `GET /v1/runs/{id}` first and sends `POST /v1/runs/{id}/stop` only to a run
  that is still live, so a run the gateway already finished costs one GET.
- Once per run: the close is claimed under the run row lock and recorded as run
  events `gateway_remote_close_requested` / `_done` / `_failed`. Each carries who
  closed the run and why (an operator's cancellation provenance, or
  `board_timeout` / `board_stale` / `board_cancelled` / `terminal_completion`
  with the run's correlation id); the same provenance goes to the gateway as
  `x-paperclip-*` headers. A failed or unreachable close is retried at most 3
  times, at least 5 minutes apart.
- A retry of the run is not affected: only the remote run is stopped, never the
  Hermes session, so the retry continues the same conversation, and a closed run
  is never re-closed or re-dispatched.
- Fix: a cancellation reason with non-Latin-1 text (for example Russian) made
  `fetch` throw while building the `x-paperclip-cancellation-reason` header, so
  the best-effort stop never reached the gateway. Header values are now
  percent-encoded when needed, single-line and bounded.
- To verify, let a gateway run outlive its board run (for example fail it on the
  execution-control deadline) and check that the run's events hold
  `gateway_remote_close_done` and that the gateway no longer lists the run as live.

## changelog-ru

### HERMES-GATEWAY-CLOSE: доска освобождает слот шлюза у каждого завершённого прогона (OPE-11889)

- Прогон `hermes_gateway` занимает слот в `max_concurrent_runs` шлюза бота, пока
  жив удалённый прогон. Раньше доска останавливала его только при отмене
  оператором прогона без активного супервизора, поэтому прогоны, которые доска
  завершила иначе (дедлайн execution-control, уборка stale или `process_lost`,
  сбой адаптера при живом удалённом прогоне), держали слот до собственного
  таймаута шлюза, а боты отвечали `Too many concurrent runs (max 8)`.
- Теперь любой терминальный статус (`succeeded`, `failed`, `timed_out`,
  `cancelled`, `interrupted`) закрывает удалённый прогон: центральные писатели
  статуса и реконсиляция execution-control делают это сразу, а периодический
  sweep (раз в 60 с, прогоны, менявшиеся за последние 2 ч) страхует все прочие
  пути и сбой между терминальной записью и закрытием. Доска сначала
  опрашивает `GET /v1/runs/{id}` и шлёт `POST /v1/runs/{id}/stop` только
  живому прогону, так что уже завершённый на шлюзе прогон стоит одного GET.
- Один раз на прогон: закрытие занимается под блокировкой строки прогона и
  пишется событиями прогона `gateway_remote_close_requested` / `_done` /
  `_failed`. В каждом — кто закрыл и почему (provenance отмены оператором либо
  `board_timeout` / `board_stale` / `board_cancelled` / `terminal_completion` с
  correlation id прогона); тот же provenance уходит шлюзу заголовками
  `x-paperclip-*`. Неудавшееся или недоступное закрытие повторяется не более 3
  раз с интервалом не менее 5 минут.
- Повтор прогона не страдает: останавливается только удалённый прогон, но не
  сессия Hermes, поэтому повтор продолжает тот же разговор, а закрытый прогон
  не закрывается и не запускается повторно.
- Исправление: причина отмены не из Latin-1 (например, русская) заставляла
  `fetch` бросать исключение при сборке заголовка
  `x-paperclip-cancellation-reason`, и остановка не доходила до шлюза. Значения
  заголовков теперь кодируются при необходимости, однострочные и ограничены по
  длине.
- Проверка: оставить удалённый прогон шлюза живым после завершения прогона на
  доске (например, провалить его по дедлайну execution-control) и убедиться, что
  в событиях прогона есть `gateway_remote_close_done`, а шлюз больше не
  показывает прогон как живой.
