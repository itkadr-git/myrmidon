## changelog-en

### Process split follow-ups: one worker shutdown, fail-closed single-route proxy (OPE-9107)

- The worker entry no longer installs a second SIGTERM handler: the board
  runtime shutdown is idempotent, so a repeated signal closes resources once.
- The single-route proxy of an api process fails closed: when the
  `singletonProxy` setting cannot be read and has no cached value it forwards
  to the worker (503 with `Retry-After` while the worker is down) instead of
  serving the route locally.
- Headers named in `Connection:` are removed in both directions (RFC 9110
  section 7.6.1). The worker gets `X-Forwarded-For` equal to the client address
  resolved by the api process under `TRUST_PROXY`.
- Docs: a standalone worker is launched with `HOST=127.0.0.1`
  ([multi-instance.md](multi-instance.md)).

## changelog-ru

### Доработки разделения процессов: одна остановка worker, прокси одиночных маршрутов закрывается наглухо (OPE-9107)

- Вход worker не вешает второй обработчик SIGTERM: остановка рантайма доски
  идемпотентна, повторный сигнал закрывает ресурсы один раз.
- Прокси одиночных маршрутов в api-процессе закрывается наглухо: если настройку
  `singletonProxy` не удалось прочитать и кэша нет, запрос идёт на worker (503 с
  `Retry-After`, пока worker недоступен), а не обслуживается локально.
- Заголовки из `Connection:` вычищаются в обе стороны (RFC 9110, раздел 7.6.1).
  Worker получает `X-Forwarded-For` с адресом клиента, определённым api-процессом
  по `TRUST_PROXY`.
- Документация: отдельный worker запускается с `HOST=127.0.0.1`
  ([multi-instance.ru.md](multi-instance.ru.md)).
