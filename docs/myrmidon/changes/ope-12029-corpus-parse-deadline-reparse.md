## changelog-en

### Corpus: big books parse to the end, abandoned parses are cancelled, failed documents can be parsed again (1.6.6 CORPUS, OPE-12029)

- The time limit of a parse (`parserTimeoutMs`) is now counted from the moment the parse service starts
  the job, not from the submission. A document that waits in the service's queue behind others no longer
  uses its limit up, so the Nth book of a batch is no longer failed for waiting. The ceiling of the setting
  (settings screen, `PATCH /api/myrmidon/corpus/settings`, `MYRMIDON_CORPUS_PARSER_TIMEOUT_MS`) is raised from
  10 minutes to 2 hours: a scanned book of 300 pages needs about 25 minutes of OCR. The wait in the queue is
  bounded separately (4 hours).
- When an attempt gives up on a job (timeout, broken poll, abort) the module cancels the job in the parse
  service with `DELETE /v1/parse/{jobId}` instead of leaving it to run, so a retry no longer queues behind a
  dead copy of the same document. A parse service that does not know the endpoint is tolerated.
- The parse pass no longer claims more jobs than `parseConcurrency` allows across passes. A pass lasts as long as
  its slowest parse while the scheduler starts a new one every 150 s, so each new pass used to claim another
  `parseConcurrency` documents on top of the running ones and flood the parser.
- New `POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`: parses a `failed`
  document again from the bytes already stored (no delete and re-upload). The document goes back to `queued`
  with its error cleared and its job starts over with no attempts used; the answer is `202 {document, job}`,
  the audit action is `myrmidon.corpus.document_reparsed`. A document that is not `failed` (`409
  document_not_failed`) or has no stored bytes (`409 document_has_no_stored_bytes`) is refused.

## changelog-ru

### Корпус: большие книги разбираются до конца, брошенные разборы отменяются, неудавшиеся документы можно разобрать заново (1.6.6 CORPUS, OPE-12029)

- Срок разбора (`parserTimeoutMs`) теперь отсчитывается с момента, когда сервис разбора начал задание, а не с
  отправки. Документ, ожидающий в очереди сервиса за другими, больше не расходует свой срок, поэтому N-ю книгу
  пачки не отбрасывают за ожидание. Предел настройки (экран настроек, `PATCH /api/myrmidon/corpus/settings`,
  `MYRMIDON_CORPUS_PARSER_TIMEOUT_MS`) поднят с 10 минут до 2 часов: скан книги на 300 страниц распознаётся около
  25 минут. Ожидание в очереди ограничено отдельно (4 часа).
- Когда попытка отказывается от задания (срок, сбой опроса, отмена), модуль отменяет задание в сервисе разбора
  через `DELETE /v1/parse/{jobId}`, а не оставляет его работать: повтор больше не встаёт в очередь за мёртвой
  копией того же документа. Сервис разбора, не знающий этой точки, допускается.
- Проход разбора больше не берёт заданий сверх `parseConcurrency` суммарно по всем проходам. Проход длится
  столько, сколько самый долгий разбор, а планировщик запускает новый каждые 150 с, поэтому каждый новый проход
  брал ещё `parseConcurrency` документов поверх идущих и заваливал парсер.
- Новый `POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`: разбирает документ в
  статусе `failed` заново из уже сохранённых байтов (без удаления и повторной загрузки). Документ возвращается в
  `queued` с очищенной ошибкой, его задание начинается заново без потраченных попыток; ответ `202 {document,
  job}`, действие аудита `myrmidon.corpus.document_reparsed`. Документ не в `failed` (`409 document_not_failed`)
  или без сохранённых байтов (`409 document_has_no_stored_bytes`) отклоняется.
