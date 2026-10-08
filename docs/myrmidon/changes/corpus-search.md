## changelog-en

### Knowledge corpus in code: hybrid search index and document parser client (CORPUS-2.0 step 4)

- `packages/corpus` gains the search half of the module. `createPostgresSearchIndex`
  implements the `SearchIndex` port as the pilot measured it: a vector ranking over the HNSW
  index with `ef_search = 64` on L2-normalized 1024-dimension embeddings, a full-text ranking
  over the generated `fts` column with its `pg_trgm` indexed fallback, both scoped by company
  and dataset and merged by reciprocal rank fusion (`k0 = 60`, `k_candidates = 100`). Every
  hit carries `score`, `chunk`, `document` and both source ranks; the fused order is
  deterministic. Dataset and `ready` filtering join `corpus_documents`, where part A put them.
- Clusters without pgvector stay usable rather than broken: the package migrations create the
  full-text objects everywhere but the vector objects (the `embedding` column, its HNSW index)
  only where the extension exists, so a search that carries an embedding there fails with the
  module's own `CorpusVectorSearchUnavailableError` — naming the missing migration and keeping
  the driver error as `pgError` — while a search without an embedding still answers from the
  full-text ranking. A raw "undefined column" from the driver no longer reaches the worker. Fresh
  installations and the production cluster already carry the extension, so this path covers installs
  that are upgraded in place.
- Document ingestion behind the ports of part A: the sliding-window chunker (300–1500
  characters, 150 characters of overlap, boundaries on line breaks, configurable), batch
  embedding through the module `Embedder` port, and one atomic `replaceDocumentChunks` call at
  the end, so a gateway failure leaves a document the chunks it already had instead of half of
  a new set. The failure carries a retryable/permanent flag.
- `createHttpDocumentParser` implements the `DocumentParser` port on top of the HTTP client
  (submit, poll, timeouts, retries): the service's pages become parsed blocks in reading
  order, a plain-text answer becomes a single block, and failures are thrown as a typed
  `DocumentParserError` with `retryable` set — the flag the worker needs to record a failed job
  and let the queue retry it, instead of losing the worker. The richer client surface
  (submit/poll/outcome) stays exported, and the wire contract is written down in
  `src/parser/README.md`.
- Tests: fusion, vector helpers, chunker boundaries and `chunk_id` idempotency, the ingestion
  pipeline against the `Embedder` port, both parser surfaces against a mock HTTP server (bytes
  and source-URI submissions, retries, a refused and a failed job, an unreachable service), and
  an integration test for the search path that runs against a pgvector stand when
  `CORPUS_TEST_PGVECTOR_DSN` is set and skips with a printed reason otherwise. The search SQL
  itself is unit-tested through a recording SQL executor, so the ordinary run needs no database.
- This is the code half of the corpus step; wiring the module to routes, settings and the UI
  follows in the later parts of CORPUS-2.0.

## changelog-ru

### Корпус знаний в коде: гибридный поиск и клиент разбора документов (CORPUS-2.0, шаг 4)

- В `packages/corpus` появилась поисковая половина модуля. `createPostgresSearchIndex`
  реализует порт `SearchIndex` так, как это измерил пилот: векторный поиск по индексу HNSW
  с `ef_search = 64` по L2-нормализованным эмбеддингам размерности 1024, полнотекстовый поиск
  по генерируемой колонке `fts` с индексированным запасным путём по `pg_trgm`, оба с фильтром
  по компании и датасету и слиянием через reciprocal rank fusion (`k0 = 60`,
  `k_candidates = 100`). Каждая находка несёт `score`, `chunk`, `document` и оба исходных
  ранга; порядок после слияния детерминирован. Фильтр по датасету и по статусу `ready` идёт
  через соединение с `corpus_documents` — там, где их разместила часть A.
- Кластер без pgvector остаётся рабочим, а не сломанным: миграции пакета создают
  полнотекстовые объекты везде, а векторные (колонка `embedding` и её индекс HNSW) — только там,
  где есть расширение, поэтому поиск с эмбеддингом на таком кластере падает собственной ошибкой
  модуля `CorpusVectorSearchUnavailableError` — в ней названа недостающая миграция, а ошибка
  драйвера сохранена в `pgError` — тогда как поиск без эмбеддинга по-прежнему отвечает
  полнотекстовым ранжированием. Сырое «undefined column» от драйвера до воркера больше не доходит.
  Свежие установки и боевой кластер расширение уже несут, так что этот путь — для установок,
  обновлённых на месте.
- Конвейер загрузки документов собран за портами части A: чанкинг скользящим окном
  (300–1500 знаков, перекрытие 150, границы по переводам строк, конфигурируемо),
  батч-эмбеддинг через порт `Embedder` и один атомарный вызов `replaceDocumentChunks` в
  конце, поэтому сбой шлюза оставляет у документа те чанки, что были, а не половину новых.
  У сбоя есть признак «повторяемо/навсегда».
- `createHttpDocumentParser` реализует порт `DocumentParser` поверх HTTP-клиента (отправка,
  поллинг, таймауты, повторы): страницы сервиса становятся разобранными блоками в порядке
  чтения, ответ одним текстом — одним блоком, а сбои бросаются типизированной
  `DocumentParserError` с признаком `retryable` — тем самым, по которому воркер запишет
  failed-джобу и очередь её повторит, вместо падения воркера. Более богатая поверхность
  клиента (submit/poll/outcome) остаётся экспортированной, контракт запроса и ответа описан в
  `src/parser/README.md`.
- Тесты: слияние RRF, векторные помощники, границы окон чанкера и идемпотентность `chunk_id`,
  конвейер загрузки против порта `Embedder`, обе поверхности клиента разбора против
  мок-сервера (передача байтов и ссылки, повторы, отказ и провал джобы, недоступный сервис) и
  интеграционный тест поиска на стенде pgvector, который включается переменной
  `CORPUS_TEST_PGVECTOR_DSN`, а без неё пропускается с печатью причины. Сам SQL поиска покрыт
  юнит-тестами через записывающий исполнитель и базы не требует.
- Это кодовая половина шага корпуса; подключение модуля к маршрутам, настройкам и интерфейсу —
  в следующих частях CORPUS-2.0.