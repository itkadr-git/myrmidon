## changelog-en

### Corpus: a failed document is parsed again with one button in the board UI (1.6.7 CORPUS-UI, OPE-12058)

- The documents table of the knowledge corpus screen shows a «Reparse» button for every document whose
  parse has failed (the RU text is «Разобрать заново»). It calls the reparse route the server half
  shipped in OPE-12029 (`POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`,
  `202 {document, job}`) — before this change the screen called the non-existent `…/retry` route and the
  button answered 404. The row is replaced with the returned document at once (back to `queued`, error
  cleared) and then confirmed by a refetch, so the list never keeps showing a stale `failed` row.
- Refusals of the route surface with their response text: `409 document_not_failed` / `409
  document_has_no_stored_bytes`, `422` when the embedder is not configured, `502 enqueue_failed` — the
  screen shows the `message` field of the error body (the human text), not the machine token.

## changelog-ru

### Корпус: неудавшийся документ разбирается заново одной кнопкой в интерфейсе доски (1.6.7 CORPUS-UI, OPE-12058)

- В таблице документов экрана «База знаний» у каждого документа с провалившимся разбором появилась кнопка
  «Разобрать заново» (в английском интерфейсе — «Reparse»). Она вызывает ручку разбора заново из серверной
  части OPE-12029 (`POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`,
  `202 {document, job}`) — до этого изменения экран обращался к несуществующей ручке `…/retry`, и кнопка
  отвечала 404. Строка документа сразу заменяется на документ из ответа (снова `queued`, причина ошибки
  очищена) и затем подтверждается перечитыванием списка, поэтому в таблице не остаётся устаревшей строки
  `failed`.
- Отказы ручки показываются текстом ответа: `409 document_not_failed` / `409
  document_has_no_stored_bytes`, `422` при ненастроенном эмбеддере, `502 enqueue_failed` — на экране
  выводится поле `message` тела ошибки (человекочитаемый текст), а не машинный токен.
