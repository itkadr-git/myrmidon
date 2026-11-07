---
settings-section: 1.6.6 — CORPUS-2.0 C: knowledge corpus server side
---

## changelog-en

### Corpus: a board restart no longer strands a document in `parsing`, and a shutdown no longer waits for a whole book (1.6.6 CORPUS, OPE-12057)

- When the board restarted in the middle of a parse, the job stayed `running` and the document `parsing`
  for good: the parse queue only claims `pending` jobs and nothing took a `running` one back. Now the
  first pass of the parse worker after a start settles every job left `running` by the previous process,
  before it claims anything: the job goes back to `pending` (due at once, no backoff) and its document to
  `queued`, with the reason ("the board stopped or restarted while the document was being parsed") kept
  on both. The attempt the claim counted stays counted, so a document that takes the board down every
  time (out of memory on a huge scan) runs out of attempts and ends `failed` with that reason, instead of
  restarting the board in a loop; a failed document can be parsed again with the reparse request. A
  document that had already reached `ready` before the process died is settled as done, not parsed twice.
  Jobs of the running process are never touched: the settling happens once per worker, before its first
  claim, and a process has exactly one worker. A job whose settling fails (database down) is retried on the
  next pass, and nothing is claimed until it works.
- A board shutdown used to wait, without a limit, for the whole parse pass to end - a scanned book takes the
  better part of an hour. The parse worker is no longer part of that wait. On a shutdown signal it stops
  claiming, lets the parses in flight finish for a grace period (30 s by default, `MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS`,
  0 to 600000 ms), then aborts them: the parser client ends the call without retries and cancels the job
  in the parse service (`DELETE /v1/parse/{jobId}`), the corpus job goes back to the queue with its attempt
  refunded (a deploy does not use up `maxParseAttempts`) and the document to `queued`. After the abort the
  shutdown waits at most 10 s more; a parse that still does not answer is left `running` and the next
  start settles it as above. The shutdown is therefore bounded by the grace period plus 10 s.
- The parser client reports an aborted call as its own error kind, `aborted`, and does not retry it.

## changelog-ru

### Корпус: перезапуск доски больше не оставляет документ в `parsing`, а остановка не ждёт целую книгу (1.6.6 CORPUS, OPE-12057)

- Если доска перезапускалась посреди разбора, задание навсегда оставалось `running`, а документ - `parsing`:
  очередь разбора берёт только `pending`, и `running` никто не возвращал. Теперь первый проход воркера разбора
  после старта до любых захватов приводит в порядок все задания, оставленные `running` прошлым процессом:
  задание возвращается в `pending` (срок наступил сразу, без задержки), документ - в `queued`, причина
  («доска остановилась или перезапустилась во время разбора документа») остаётся на обоих. Попытка, которую
  посчитал захват, остаётся посчитанной: документ, который роняет доску каждый раз (нехватка памяти на
  огромном скане), исчерпает попытки и закончит `failed` с этой причиной, а не будет перезапускать доску по
  кругу; `failed`-документ можно разобрать заново запросом reparse. Документ, который успел стать `ready` до
  гибели процесса, закрывается как выполненный, а не разбирается дважды. Задания живого процесса не
  затрагиваются: приведение в порядок идёт один раз на воркер, до его первого захвата, а воркер в процессе
  один. Если приведение в порядок не удалось (база недоступна), оно повторяется на следующем проходе, и до
  успеха ничего не захватывается.
- Остановка доски ждала без ограничения конца всего прохода разбора - скан книги идёт большую часть часа.
  Воркер разбора больше не входит в это ожидание. По сигналу остановки он перестаёт захватывать задания, даёт
  идущим разборам закончиться в течение льготного срока (по умолчанию 30 с, `MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS`,
  от 0 до 600000 мс), затем прерывает их: клиент парсера завершает вызов без повторов и отменяет задание в
  сервисе разбора (`DELETE /v1/parse/{jobId}`), задание корпуса возвращается в очередь с возвращённой
  попыткой (выкат не расходует `maxParseAttempts`), документ - в `queued`. После прерывания остановка ждёт ещё
  не более 10 с; разбор, который и тогда не ответил, остаётся `running`, и следующий старт приведёт его в
  порядок, как описано выше. Итого остановка ограничена льготным сроком плюс 10 с.
- Клиент парсера сообщает о прерванном вызове отдельным видом ошибки `aborted` и не повторяет его.

## settings-en

| `MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS` | CORPUS-2.0 C (OPE-12057) | `30000` | How long a board shutdown lets the corpus parses in flight finish before it aborts them. An aborted parse is cancelled in the parse service, its job goes back to the queue with the attempt refunded and its document to `queued`; after the abort the shutdown waits at most 10 s more. So a restart is bounded by this value plus 10 s, however long the book | Not a switch: `0` aborts at once. Unset, non-numeric or negative - the default; above `600000` - `600000` |

## settings-ru

| `MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS` | CORPUS-2.0 C (OPE-12057) | `30000` | Сколько остановка доски даёт идущим разборам корпуса закончиться, прежде чем прервать их. Прерванный разбор отменяется в сервисе разбора, его задание возвращается в очередь с возвращённой попыткой, документ - в `queued`; после прерывания остановка ждёт ещё не более 10 с. Перезапуск ограничен этим значением плюс 10 с, как бы долго ни шла книга | Не выключатель: `0` - прервать сразу. Не задана, не число или отрицательная - умолчание; больше `600000` - `600000` |
