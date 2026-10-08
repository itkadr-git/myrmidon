---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### Board bots search and read the knowledge corpus with the corpus_* MCP tools (1.6.6 CORPUS-2.0, part D — MCP)

- The board now serves a company's corpus over its own MCP endpoint,
  `POST /api/myrmidon/companies/:companyId/corpus/mcp` (`initialize`, `tools/list`,
  `tools/call`), next to the existing OCR endpoint. It answers with the four tools
  the RAGFlow facade answered before — `corpus_search` (query, dataset(s), top_k →
  chunks with a score, the document they came from and a link),
  `corpus_get_document`, `corpus_list_datasets`, `corpus_list_documents` — so a
  shadow comparison can put the same request to both paths.
- The tools follow the module's switch and are read on every call, so switching
  the corpus on or off takes effect on the bot's next call, with no restart. With
  the module off, `tools/list` comes back empty and a call that names a corpus
  tool is answered as a tool result with `corpus_disabled`: a bot on an instance
  that never turned the corpus on sees exactly the tool set it saw before.
- The operator's purpose limit holds: a `top_k`/`limit` above the module's ceiling
  is refused with `invalid_tool_input` instead of being silently clamped.
- Every failure is a tool result carrying a stable code — `corpus_disabled`,
  `corpus_unavailable`, `invalid_tool_input`, `dataset_not_found`,
  `document_not_found`, `query_failed` — never a broken transport a bot can only
  retry blindly.

## changelog-ru

### Боты доски ищут и читают корпус знаний инструментами corpus_* (1.6.6 CORPUS-2.0, часть D — MCP)

- Доска отдаёт корпус компании собственным MCP-эндпоинтом
  `POST /api/myrmidon/companies/:companyId/corpus/mcp` (`initialize`, `tools/list`,
  `tools/call`) рядом с уже существующим эндпоинтом OCR. Отвечает он четырьмя
  инструментами, которые раньше отвечал фасад RAGFlow — `corpus_search` (запрос,
  датасет(ы), top_k → чанки со score, документом-источником и ссылкой),
  `corpus_get_document`, `corpus_list_datasets`, `corpus_list_documents`, — чтобы
  теневой прогон мог задать один и тот же запрос обоим путям.
- Инструменты следуют переключателю модуля и читаются на каждом вызове, поэтому
  включение и выключение корпуса действует со следующего вызова бота, без
  перезапуска. При выключенном модуле `tools/list` приходит пустым, а вызов,
  назвавший инструмент корпуса, отвечает результатом с `corpus_disabled`: бот на
  инстансе, где корпус никогда не включали, видит ровно тот же набор инструментов,
  что и раньше.
- Предел, заданный оператором, соблюдается: `top_k`/`limit` выше потолка модуля
  отклоняется кодом `invalid_tool_input`, а не подрезается молча.
- Любая неудача — это результат инструмента со стабильным кодом
  (`corpus_disabled`, `corpus_unavailable`, `invalid_tool_input`,
  `dataset_not_found`, `document_not_found`, `query_failed`), а не сломанный
  транспорт, который бот может только слепо повторить.

## divergence-new

<!-- after: Трек 3 — шлюз инструментов и адаптер Hermes -->

### 1.6.6 — CORPUS-2.0, часть D: MCP-инструменты corpus_* для ботов

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.6-CORPUS-D | Новый серверный модуль `corpus` (только наши файлы, `server/src/myrmidon/corpus/**`): MCP-эндпоинт `POST /myrmidon/companies/:companyId/corpus/mcp` с инструментами `corpus_search` / `corpus_get_document` / `corpus_list_datasets` / `corpus_list_documents` поверх порта `CorpusMcpPort`. В вендорском `server/src/app.ts` — одна строка монтирования рядом с OCR, помеченная `myrmidon(1.6.6-CORPUS-D)`. | `server/src/app.ts` — импорт `myrmidonCorpusRoutes` и `api.use(...)` одной строкой с маркером `myrmidon(1.6.6-CORPUS-D)` | Доска даёт ботам корпус инструментами, а не фасадом RAGFlow; эндпоинт и маршрут нужны, чтобы бот мог быть настроен на корпус, а не на RAGFlow (теневой режим OPE-6166) | `server/src/myrmidon/corpus/tools.myrmidon.test.ts`, `mcp.myrmidon.test.ts`, `mcp-embedded-db.myrmidon.test.ts` (реальная БД: переключатель в `instance_settings.general.corpus` и поиск по проиндексированному документу) | Снимать нечего: модуль наш (MIT), вендорского кода не переписываем — при удалении эндпоинта убрать строку в `app.ts` и каталог `server/src/myrmidon/corpus/` | этот PR |