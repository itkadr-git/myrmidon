## changelog-en

### LITELLM-WORKERS-UI: the "Gateway workers" tab on the Costs page (1.6.5)

- The Costs page gains a third gateway tab, "Gateway workers", beside
  "Gateway" and "Gateway keys": an input for the desired LiteLLM process
  count (seeded from the server's `target`), the CPU and memory ceilings
  shown as hints, an Apply button behind a confirm step, and a status line
  while `current` moves to `target`. A target above `maxByMemory` is caught
  on the client; a 400 from the server is shown with the server's own text.
- Metrics card: per-worker CPU bars, median response time and the request
  queue depth, refreshed every 30 seconds from
  `GET /api/myrmidon/companies/:id/litellm/workers`.
- Auto-select card: shows the switch state and turns it on or off through
  the same `PUT …/workers` (the threshold logic itself runs on the server).
  When the backend does not carry the optional `auto` field, the switch is
  disabled with an explanation — manual control keeps working.

## changelog-ru

### LITELLM-WORKERS-UI: вкладка «Gateway workers» на странице «Затраты» (1.6.5)

- На странице «Затраты» появляется третья вкладка шлюза — «Gateway workers»
  рядом с «Gateway» и «Gateway keys»: поле желаемого числа процессов LiteLLM
  (начальное значение — `target` с сервера), подсказки с потолками по CPU и
  памяти, кнопка применения с шагом подтверждения и строка состояния, пока
  `current` переходит в `target`. Значение выше `maxByMemory` отсекается на
  клиенте; ответ 400 сервера показывается его же текстом.
- Карточка метрик: загрузка CPU по процессам, медиана времени ответа и
  глубина очереди — обновляются каждые 30 секунд из
  `GET /api/myrmidon/companies/:id/litellm/workers`.
- Карточка автоподбора: показывает состояние переключателя и включает/выключает
  его тем же `PUT …/workers` (пороговая логика живёт на сервере). Если backend
  не отдаёт необязательное поле `auto`, переключатель выключен с пояснением —
  ручное управление продолжает работать.
