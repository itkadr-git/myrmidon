## changelog-en

### Adapter environment failures release execution tasks (OPE-8598)

- Execution recovery classifies structured adapter license/pool failures as executor health, clears the execution assignment and pointers, and returns the task to the unassigned `todo` queue for swarm claim instead of creating a task-level block without blocker metadata.
- Classification covers Antigravity error codes (including `antigravity_not_licensed` and `antigravity_pool_unavailable`), known adapter error families, and bounded diagnostics including the Russian production messages. Unrelated mentions of `LICENSE` in log excerpts do not trigger release.
- Tests cover the production failure signatures, false-positive protection, release semantics, and task re-availability.

## changelog-ru

### Сбой среды адаптера освобождает задачу для повторного захвата (OPE-8598)

- Execution-recovery классифицирует структурированные ошибки лицензии/пула адаптера как проблему среды исполнителя, очищает назначение и execution pointers и возвращает задачу в не назначенную никому очередь `todo` для swarm claim вместо блокировки задачи без blocker metadata.
- Классификация покрывает коды Antigravity (в том числе `antigravity_not_licensed` и `antigravity_pool_unavailable`), известные семейства ошибок адаптера и ограниченные диагностические сообщения, включая русские сообщения из production. Случайное упоминание `LICENSE` в выдержке лога не вызывает освобождение задачи.
- Тесты покрывают производственные сигнатуры отказа, защиту от ложных срабатываний и освобождение задачи для нового захвата.

## divergence-new

<!-- after: 1.6.5 — F-26 T10 SWARM-SCENT: запах задачи и агента, логика Jev -->

### 1.6.6 — EXECUTION-RECOVERY: ошибки среды адаптера освобождают задачу

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | PR |
|---|---|---|---|---|---|---|
|---|---|---|---|---|---|---|
| OPE-8598 | Адаптерные license/pool error codes и ограниченные error-family/диагностики освобождают задачу в unassigned `todo`, очищая execution pointers; произвольные stdout/stderr LICENSE-упоминания не классифицируются | `server/src/services/execution-recovery-resolution.ts`; + `server/src/services/execution-recovery-resolution.myrmidon.test.ts` | Адаптерный сбой переводил задачу в `blocked` без blocker metadata, а сохранённый assignee исключал её из swarm claim | Коды Antigravity (включая `antigravity_pool_unavailable`), семейства ошибок, русский текст и защита от ложного срабатывания | Никогда, наше поведение. Снять ветку и тесты при поддержке классификации здоровья адаптера вендором | #1517 (этот PR, обновлён) |
