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
