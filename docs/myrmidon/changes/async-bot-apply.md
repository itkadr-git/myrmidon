## changelog-en

### "Apply now" on the bot card is asynchronous: 202 + apply id, background pass, DB status (ASYNC-BOT-APPLY)

- The apply button used to run the whole reconcile inside the HTTP request and
  held it for ~36 s on a cold restart (facts §6.3). `POST
  /api/myrmidon/agents/:id/bot-container/apply` now validates what the old
  route validated inline (feature flag, runtime presence, saved-card
  applicability — same 409/503 answers as before), journals one row in the new
  `bot_apply_jobs` table and answers **202 `{ applyId, status }` in under a
  second**. The reconcile pass runs in the background of the same process
  (fire-and-forget; every outcome is written to the job row, no unhandled
  rejection, no new dependencies, no restart).
- `GET /api/myrmidon/agents/:id/bot-container/apply/:applyId` reads **only the
  database** and answers `{ status, error, startedAt, finishedAt }` with
  `status` walking `pending → running → succeeded | failed`. A failed pass
  stores the (clipped) failure text in `error`, so the outcome a presser needs
  is never lost in a catch. Unknown/foreign ids answer 404; the route is
  board-actor-gated like the POST.
- Idempotency: while a bot has a live (`pending`/`running`) job, a repeated
  POST returns that job's id instead of queueing a second pass; the
  `bot_apply_jobs` partial unique index enforces one live row per bot across
  racing POSTs and api processes, and the store re-reads the winner's row on a
  unique violation. A live job older than ten minutes is an orphan of a
  stopped board process: the next POST closes it as `failed` (the reason stays
  readable through the status route) and starts a fresh pass, so a crash never
  pins the bot to a dead job id.
- Contract for the board UI (part B of the parent task): after the 202, poll the GET
  status until it leaves `pending`/`running`; render `error` on `failed`.

## changelog-ru

### Кнопка «Применить сейчас» на карточке бота стала асинхронной: 202 + id применения, фоновое применение, статус из БД (ASYNC-BOT-APPLY)

- Применение выполнялось целиком внутри HTTP-запроса и держало его ~36 с на
  холодном рестарте (facts §6.3). `POST
  /api/myrmidon/agents/:id/bot-container/apply` теперь на месте проверяет то же,
  что и старый маршрут (флаг, наличие рантайма, применимость сохранённой
  карточки — те же 409/503), записывает одну строку в новую таблицу
  `bot_apply_jobs` и отвечает **202 `{ applyId, status }` менее чем за секунду**.
  Сам проход сверки выполняется в фоне того же процесса (fire-and-forget; исход
  пишется в строку job, unhandled rejection исключён, новых зависимостей и
  перезапуска нет).
- `GET /api/myrmidon/agents/:id/bot-container/apply/:applyId` читает **только
  базу** и отвечает `{ status, error, startedAt, finishedAt }`, где `status`
  проходит `pending → running → succeeded | failed`. При ошибке текст (с
  обрезкой) сохраняется в `error` — итог, ради которого нажимали кнопку, не
  теряется в catch. Неизвестный/чужой id — 404; маршрут, как и POST, только для
  борд-актора.
- Идемпотентность: пока у бота есть живой job (`pending`/`running`), повторный
  POST возвращает его id, не запуская второй проход; частичный уникальный
  индекс `bot_apply_jobs` гарантирует один живой row на бота при гонке POST-ов и
  нескольких api-процессов — проигравший перечитывает row победителя. Живой
  job старше десяти минут — сирота остановленного процесса доски: следующий POST
  закрывает его как `failed` (причина видна через маршрут статуса) и запускает
  новый проход, так что падение процесса не привязывает бота к мёртвому id.
- Контракт для интерфейса доски (часть B родительской задачи): после 202 опрашивать GET
  статуса, пока статус не выйдет из `pending`/`running`; при `failed` показывать
  `error`.
