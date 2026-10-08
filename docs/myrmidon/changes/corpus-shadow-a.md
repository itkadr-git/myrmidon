---
divergence-section: 1.6.6 — CORPUS-SHADOW A: теневой вызов модуля корпуса
---

## changelog-en

### Corpus shadow mode behind the `corpus.shadow` flag (1.6.6 CORPUS, part A)

- A new instance behavior flag `corpus.shadow` (off by default) compares the
  knowledge-corpus module against RAGFlow without touching bot answers: every
  remote-MCP search call that completes normally gets a fire-and-forget shadow
  leg, and the bot still receives the RAGFlow result exactly as before.
- Each shadow call writes one row into the new `corpus_shadow_log` table
  (migration 0331): bot, dataset, query, the chunk ids and latency of both
  legs, and — for the module leg only — the error text. Module failures never
  surface to the bot.
- The `GET /metrics` endpoint now exposes p50/p95 of both legs
  (`myrmidon_corpus_shadow_ragflow_latency_seconds`,
  `myrmidon_corpus_shadow_module_latency_seconds`) read from the shadow log
  inside the scrape window; with the flag off the families render without
  samples.

## changelog-ru

### Теневой режим модуля корпуса за флагом `corpus.shadow` (1.6.6 CORPUS, часть A)

- Новый поведенческий флаг уровня инстанса `corpus.shadow` (по умолчанию
  выключен) сравнивает модуль корпуса знаний с RAGFlow, не затрагивая ответы
  ботов: каждый успешно завершённый remote-MCP поиск получает fire-and-forget
  теневую ветку, а бот по-прежнему получает результат RAGFlow как раньше.
- Каждый теневой вызов пишет одну строку в новую таблицу `corpus_shadow_log`
  (миграция 0331): бот, датасет, запрос, id чанков и задержки обеих веток и —
  только по модульной ветке — текст ошибки. Ошибки модуля не видны боту.
- `GET /metrics` отдаёт p50/p95 обеих веток
  (`myrmidon_corpus_shadow_ragflow_latency_seconds`,
  `myrmidon_corpus_shadow_module_latency_seconds`) из shadow-лога внутри окна
  скрейпа; с выключенным флагом семьи рендерятся без сэмплов.

## divergence-new

### 1.6.6 — CORPUS-SHADOW A: теневой вызов модуля корпуса

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-CORPUS-SHADOW-A | На успешном хвосте remote-MCP вызова (`mcp_remote_http`/`mcp_remote_stdio`, POST `tools/call`) в `executeTool` врезан fire-and-forget теневой прогон модуля корпуса: `maybeRecordShadowSearchCall` читает флаг `corpus.shadow` (выключен = ноль поведенческих изменений), запускает теневую ветку за портом `SearchIndex`-формы (OPE-6165; до сборки реального гибридного индекса — no-op, строка пишется с пустым `module_chunk_ids`) и пишет строку в `corpus_shadow_log` (миграция 0331) с латентностями обеих веток; ответ боту строится до врезки и не читает ни одного поля результата тени; ошибки модуля — только `module_error`, таймаут тени не влияет на бота. Метрики p95 обеих веток (`myrmidon_corpus_shadow_{ragflow,module}_latency_seconds`, summary поверх `corpus_shadow_log` в окне скрейпа) — в `server/src/myrmidon/monitoring/metrics/metrics.ts` | Наши файлы: `server/src/myrmidon/corpus-shadow.ts`, `packages/db/src/schema/corpus_shadow_log.ts`, миграция 0331 + меты; в вендоре помечены `myrmidon(1.6.6-CORPUS-SHADOW A)`: `server/src/services/tool-gateway.ts` (импорт, `corpusShadowRunner`/`options.corpusShadowRunner`, `shadowRagflowStartedAt`, хук перед успешным `return`), `packages/shared/src/myrmidon-behavior-settings.ts` (флаг `corpus.shadow`), `server/src/myrmidon/monitoring/metrics/metrics.ts` (две summary-семьи p50/p95 обеих веток) | OPE-6166 ч.A: собрать 2–3 дня данных сравнения RAGFlow vs корпус перед переключением (решение владельца 08.10) | `server/src/myrmidon/corpus-shadow.myrmidon.test.ts` (тесты: флаг выключен — ни вызова ни записи; флаг включён — запись есть, план ответа идентичен; ошибка модуля и таймаут — только `module_error`; matcher поиска; p95) + `packages/db/src/corpus-shadow-log-migration.myrmidon.test.ts` (файл/журнал/снапшот/DQL против замороженного контракта) | Снять после заключения части B (OPE-6166): удалить хук `myrmidon(1.6.6-CORPUS-SHADOW A)` из gateway и модуль; таблицу и миграцию не откатывать (история сравнения) | (этот PR) |
