## changelog-en

### Bot-card "Apply now" now shows the async apply: progress, applied time, failure text (ASYNC-BOT-APPLY-UI)

- After `POST .../bot-container/apply` answers 202 + `applyId` (ASYNC-BOT-APPLY,
  server side), the agent card polls `GET .../bot-container/apply/:applyId`
  every 2 s instead of holding a 36 s request open. While the pass is live the
  button reads "Applying…", is disabled, carries a spinner, and a progress
  line explains that the result will appear on the card.
- The outcome is rendered on the card: a succeeded job shows the finish time
  ("Applied at 14:03:12."), a failed one shows the server's error text — on
  screen, not only in the console. The live `applyId` is kept in
  `sessionStorage`, so reloading the page in the first minutes resumes the
  same job and the outcome (error included) is not lost with the component;
  the first poll after resume catches a job that finished while the page was
  closed.
- A poll round lasts at most ~2 minutes; then the card says the apply is still
  running and to check again in a few minutes, and the button becomes
  pressable again. Pressing it again returns the still-live job's id from the
  server (one pass, not two). An unknown job id (404 — e.g. the instance was
  rebuilt while the page was open) stops the poll and shows that reason.
- Backward compatible: a server older than ASYNC-BOT-APPLY still answers the
  POST synchronously with an `outcome`, and the card words it exactly as
  before, so this UI can merge before the server part.

## changelog-ru

### Кнопка «Применить сейчас» на карточке бота показывает асинхронное применение: ход, время применения, текст ошибки (ASYNC-BOT-APPLY-UI)

- После того как `POST .../bot-container/apply` отвечает 202 + `applyId`
  (ASYNC-BOT-APPLY, серверная часть), карточка бота опрашивает
  `GET .../bot-container/apply/:applyId` раз в 2 с вместо того, чтобы держать
  открытый 36-секундный запрос. Пока проход жив, кнопка читается как
  «Применяется…», она недоступна, на ней спиннер, а под кнопками — строка
  хода: результат появится на карточке.
- Итог выводится на карточке: успешный job показывает время завершения
  («Применено в 14:03:12.»), упавший — текст ошибки от сервера, на экране, а
  не только в консоли. Живой `applyId` хранится в `sessionStorage`, поэтому
  перезагрузка страницы в первые минуты возобновляет наблюдение за тем же
  job, и итог (вместе с ошибкой) не теряется вместе с компонентом: первый
  опрос после возобновления подхватывает job, завершившийся, пока страница
  была закрыта.
- Раунд опроса длится не дольше ~2 минут: затем карточка говорит, что
  применение ещё выполняется и стоит проверить позже, а кнопка снова становится
  доступной. Повторное нажатие сервер отдаёт id всё ещё живого job — один
  проход, не два. Неизвестный id (404, например инстанс пересобрали, пока
  страница была открыта) останавливает опрос и показывает эту причину.
- Обратная совместимость: сервер старше ASYNC-BOT-APPLY по-прежнему отвечает
  на POST синхронно с `outcome`, и карточка формулирует его как раньше, —
  эта UI-часть может слиться раньше серверной.
