---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### One copy of the execution continuation per run (1.6.5 PERF-DIET)

- A run snapshot used to store the execution continuation envelope twice: at the
  top level of `context_snapshot` and inside `paperclipWake`, about 90-100 KB
  each — roughly 354 MB of duplicates across the table.
- The wake payload is now the only copy. `buildPaperclipWakePayload` takes the
  envelope as an explicit argument, so the snapshot the writer persists never
  receives a top-level `executionContinuation` key.
- Every reader goes through one accessor, `readExecutionContinuation`
  (`server/src/services/execution-continuation.ts`). It returns the wake-payload
  copy and falls back to a legacy top-level copy, so rows written before the
  migration keep working while the dedupe walks the table. The resume path
  (`buildExecutionContinuation`), the origin-comment tracking and the native
  completion feedback read through it.
- Migration `packages/db/src/migrations/0303_remove_execution_continuation_duplication.sql`
  deduplicates the rows that already exist. It moves a top-level envelope into
  `paperclipWake` when the payload has none — no envelope is dropped — and then
  removes the duplicate key. The rewrite walks the primary key in batches of 200
  rows, so a gigabyte table is never rewritten by one statement, and the
  statement is idempotent.
- Guard: `server/src/services/execution-continuation-wake-dedupe.test.ts` pins
  the canonical copy, the legacy fallback, the wake-payload priority, an empty
  envelope and the origin-comment ids.

## changelog-ru

### Одна копия executionContinuation на прогон (1.6.5 PERF-DIET)

- Снапшот прогона хранил конверт `executionContinuation` дважды — на верхнем
  уровне `context_snapshot` и внутри `paperclipWake`, по 90-100 КБ на копию,
  всего около 354 МБ дублей по таблице.
- Теперь единственная копия — в wake-payload: `buildPaperclipWakePayload`
  принимает конверт явным аргументом, поэтому сохраняемый снапшот больше не
  получает ключ `executionContinuation` верхнего уровня.
- Все читатели ходят через один аксессор `readExecutionContinuation`
  (`server/src/services/execution-continuation.ts`). Он возвращает копию из
  wake-payload и откатывается на старую копию верхнего уровня, поэтому строки,
  записанные до миграции, продолжают работать, пока дедупликация идёт по
  таблице. Через него читают путь возобновления (`buildExecutionContinuation`),
  учёт исходных комментариев и обратная связь нативного завершения.
- Миграция
  `packages/db/src/migrations/0303_remove_execution_continuation_duplication.sql`
  разбирает уже существующие строки: переносит конверт верхнего уровня внутрь
  `paperclipWake`, если там его нет — ни один конверт не теряется, — и затем
  удаляет дублирующий ключ. Перезапись идёт по первичному ключу батчами по 200
  строк, поэтому таблица на гигабайт не переписывается одним запросом;
  заявление идемпотентно.
- Сторож: `server/src/services/execution-continuation-wake-dedupe.test.ts`
  закрепляет каноническую копию, откат на старую, приоритет wake-payload,
  пустой конверт и исходные комментарии.

## divergence

| PERF-DIET-CONTINUATION | Конверт `executionContinuation` хранится один раз — внутри `paperclipWake`; снапшот прогона больше не получает копию на верхнем уровне (`buildPaperclipWakePayload` принимает конверт явным аргументом), а читатели ходят через `readExecutionContinuation` с откатом на старую копию верхнего уровня для строк, до которых миграция ещё не дошла. Миграция `0303_remove_execution_continuation_duplication.sql` переносит конверт внутрь `paperclipWake`, если там его нет, и удаляет дубль: перезапись идёт по первичному ключу батчами по 200 строк и идемпотентна. Поведение побудки не меняется: wake-payload по-прежнему несёт конверт, его собирают из памяти | `server/src/services/heartbeat.ts`, `server/src/services/execution-continuation.ts`, `server/src/services/native-runtime/native-completion-feedback.ts`; миграция `packages/db/src/migrations/0303_remove_execution_continuation_duplication.sql` (+ `meta/0303_snapshot.json`, `meta/_journal.json`); замеры `docs/performance/heartbeat_runs_optimization.sql`, документация `docs/performance/heartbeat_runs_optimization.md` и `.ru.md` | Аудит 04.10: `heartbeat_runs` 1,1 ГБ (1,07 ГБ TOAST), конверт `executionContinuation` по 90-100 КБ лежал дважды — около 354 МБ дублей | `server/src/services/execution-continuation-wake-dedupe.test.ts` (чтение канонической копии, откат на старую, приоритет wake-payload, пустой конверт, исходные комментарии) | Никогда, это наше поведение. Снятие: вернуть запись верхнего уровня в `heartbeat.ts`, убрать `readExecutionContinuation` и миграцию 0303 | (этот PR) |