---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### One stored copy of the execution continuation per run (1.6.5 RUN-SNAPSHOT-DEDUP)

- A run snapshot now holds the execution continuation envelope once, at
  `context_snapshot.executionContinuation`. The structured wake payload no
  longer carries its own copy: dispatch re-attaches the canonical envelope to
  the payload the adapter and the native runner receive, so the delivered
  prompt is unchanged. The duplicated envelope was ~90-100 KB, written twice
  into every run snapshot.
- The run detail response (`GET /api/heartbeat-runs/:id`) drops a nested
  copy that is byte-identical to the canonical one, so runs written before this
  change stop sending the envelope twice. A payload that differs from the
  canonical copy is left untouched, and no response loses information.
- The run-ownership probe (`getConversationOwnershipBlocker`) selects the six
  columns it reads instead of the whole `heartbeat_runs` row. It runs several
  times per dispatched run, and every candidate row used to arrive with its
  snapshot and result JSON attached.

## changelog-ru

### Одна сохранённая копия executionContinuation на прогон (1.6.5 RUN-SNAPSHOT-DEDUP)

- Снимок прогона хранит конверт продолжения один раз — в
  `context_snapshot.executionContinuation`. Структурная нагрузка побудки
  больше не несёт свою копию: при отправке канонический конверт
  присоединяется к нагрузке, которую получают адаптер и нативный раннер,
  поэтому доставляемый промпт не меняется. Дублированный конверт занимал
  ~90-100 КБ и писался в каждый снимок прогона дважды.
- Ответ детали прогона (`GET /api/heartbeat-runs/:id`) отбрасывает вложенную
  копию, побайтово совпадающую с канонической, поэтому прогоны, записанные до
  этого изменения, тоже перестают слать конверт дважды. Нагрузка, отличающаяся
  от канонической копии, не трогается, и ни один ответ не теряет данные.
- Проверка владения исполнением (`getConversationOwnershipBlocker`) выбирает
  шесть читаемых колонок вместо всей строки `heartbeat_runs`. Она выполняется
  несколько раз на прогон, и раньше каждая строка-кандидат приходила вместе со
  своим снимком и result JSON.
## divergence

| RUN-SNAPSHOT-DEDUP | Конверт продолжения прогона хранится в снимке один раз: каноническая копия — `context_snapshot.executionContinuation`, а структурная нагрузка побудки (`context_snapshot.paperclipWake`) больше не несёт собственную копию. Доставка не меняется: при отправке прогона канонический конверт присоединяется к нагрузке, которую рендерят адаптеры и нативный раннер (`wakePayloadForDispatch`), и это присоединение не пишется обратно в снимок (тот же приём, что у проекции ответа на карточку вопроса). Ответ детали прогона (`GET /api/heartbeat-runs/:id`) отбрасывает вложенную копию, побайтово равную канонической, поэтому строки, записанные до изменения, тоже перестают отдавать конверт дважды; отличающаяся нагрузка остаётся нетронутой. Проверка владения исполнением `getConversationOwnershipBlocker` читает шесть нужных колонок (`id`, `agentId`, `processPid`, `processGroupId`, `processStartedAt` и признак живой аренды) вместо всей строки `heartbeat_runs` с `result_json` и снимком | `server/src/services/heartbeat.ts` (метки `myrmidon(RUN-SNAPSHOT-DEDUP)`: сборка нагрузки побудки, отправка в нативный раннер и в адаптер), `server/src/services/conversation-continuation.ts`, `server/src/routes/agents.ts` + `server/src/services/run-continuation-snapshot.ts` | Аудит 04.10: `heartbeat_runs` 1,1 ГБ, из них ~1,07 ГБ TOAST; `executionContinuation` хранился дважды — на верхнем уровне и внутри `paperclipWake`, по 90-100 КБ, ~354 МБ дублей; горячая проверка владения читала строку целиком несколькими вызовами на прогон (≈74 мс только на планирование), список прогонов — 4,3 с на 701 вызов | `server/src/__tests__/run-continuation-snapshot.myrmidon.test.ts` (снимок после записи содержит ключ один раз, отправляемая нагрузка несёт конверт, устаревшая вложенная копия не доставляется, проекция ответа снимает только побайтовый дубль; замеры: байты снимка и ответа детали, время списка прогонов на обеих формах снимка, байты и время проверки владения) | Когда вендор перестанет писать конверт в нагрузку побудки и сузит выборку проверки владения сам: удалить куски `myrmidon(RUN-SNAPSHOT-DEDUP)`, модуль `run-continuation-snapshot.ts` и проекцию ответа, тест-сторож переписать на поведение вендора | (этот PR) |
