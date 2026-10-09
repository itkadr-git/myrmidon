---
---

## changelog-en

### Run limits: the admission's refusals are visible on the runs-and-queue screen (1.6.5 F-09 B)

- The Run limits section of Instance → General now shows the admission's own
  refusal counter: how many times a queue sweep left a queued run waiting
  because of a global or host ceiling, since the server started.
- The line carries the breakdown by reason (the concurrency ceiling, the start
  ramp, the server's memory floor, the host memory floor, the host CPU
  ceiling), largest first, and the reason and time of the most recent refusal.
  A reason the screen does not know is still shown under its own name.
- The counter is optional in the endpoint's reply: an older server that sends
  no `admissionDenials` renders no line at all — the screen shows nothing
  rather than a zero it invented, and the rest of the panel is unaffected.

## changelog-ru

### Лимиты прогонов: отказы допуска видны на экране «Прогоны и очередь» (1.6.5 F-09 B)

- Секция «Run limits» страницы Instance → General теперь показывает счётчик
  собственных отказов допуска: сколько раз проход очереди оставил queued-прогон
  в ожидании из-за глобального или хостового потолка, с момента старта сервера.
- Строка несёт разбивку по причинам (потолок одновременных прогонов, плавный
  старт, порог памяти сервера, порог памяти хоста, потолок CPU хоста) — от
  большей к меньшей, — а также причину и время последнего отказа. Причина,
  которой экран не знает, показывается под своим именем.
- Счётчик в ответе эндпоинта необязателен: старый сервер, не отдающий
  `admissionDenials`, не рисует строку вовсе — экран не показывает выдуманный
  ноль, остальная панель работает как прежде.