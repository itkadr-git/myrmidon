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
  an integration test for the search path that takes its database from the first source that works —
  the stand named by `CORPUS_TEST_PGVECTOR_DSN`, else the embedded PostgreSQL 18 cluster with
  pgvector staged into it by the package shim — and skips with a printed reason when neither is
  usable. The search SQL itself is unit-tested through a recording SQL executor, so the ordinary
  run needs no database, and the probe tables the integration suite creates are described by
  `src/search/probe-schema.ts`: a database-free guard (`probe-schema.myrmidon.test.ts`) asserts
  that every column the search SQL reads exists in that schema, because a probe table that has
  drifted from the query surface would otherwise only surface as a red lane on the first host that
  can run the suite.
- The vector integration suite can now actually run on CI, where it silently skipped before: the
  embedded-cluster shim unpacked the pgvector package with `tar -J`, while the embedded-postgres
  helper had prepended its own native lib directory to `LD_LIBRARY_PATH` — that directory carries an
  older `liblzma.so.5`, so the system `xz` refused to start (`version `XZ_5.4' not found`) and `tar`
  exited non-zero. The shim now hands `ar` and `tar` an environment with the loader paths removed
  (the treatment the repo's rootless runner already gives `dpkg-deb`), reads the payload member from
  `ar t` instead of assuming `data.tar.xz`, and reports a failed command together with its `stderr`,
  which is where `xz` and `tar` say what went wrong. Database-free tests pin those decisions
  (`test-pgvector.myrmidon.test.ts`), so the extension installs wherever a system `xz` exists.
- The integration stand now mirrors the migration's indexes, not only its columns. The search SQL joins
  chunks to documents by `document_id` and narrows documents by `(dataset_id, status)`, and a probe
  build without those btree indexes made the planner answer with a nested loop that scanned every
  chunk per document: CI measured a 789 ms plan on a 2000-chunk stand with `Rows Removed by Join
  Filter: 4000000`, a shape production never picks and a latency that described the stand rather than
  the product. The probe schema now creates the four btree indexes of the migration's tables, a
  database-free guard fails if any of them goes missing or stops covering the joined and filtered
  columns, and the plan test fails if that join explosion comes back.
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
  интеграционный тест поиска, который берёт базу из первого доступного источника — стенда,
  названного `CORPUS_TEST_PGVECTOR_DSN`, иначе встроенного кластера PostgreSQL 18 с pgvector,
  установленным шимом пакета, — а если недоступно ни то ни другое, пропускается с печатью
  причины. Сам SQL поиска покрыт юнит-тестами через записывающий исполнитель и базы не требует,
  а таблицы-зонды, которые создаёт интеграционный набор, описаны в `src/search/probe-schema.ts`:
  не требующий базы страж (`probe-schema.myrmidon.test.ts`) проверяет, что каждая колонка, которую
  читает SQL поиска, есть в этой схеме, — иначе разъехавшаяся таблица-зонд всплыла бы красным
  лейном только на первой машине, где набор вообще может выполниться.
- Векторный интеграционный набор теперь действительно выполняется в CI, а до этого молча
  пропускался: шим встроенного кластера распаковывал пакет pgvector через `tar -J`, а хелпер
  embedded-postgres успел добавить в `LD_LIBRARY_PATH` свой каталог нативных библиотек — в нём
  лежит более старая `liblzma.so.5`, поэтому системный `xz` отказывался стартовать
  (`version `XZ_5.4' not found`), а `tar` завершался с ошибкой. Теперь шим запускает `ar` и `tar`
  с окружением без путей загрузчика (ровно то, что рутлесс-раннер репозитория уже делает для
  `dpkg-deb`), берёт имя полезного члена из `ar t`, а не предполагает `data.tar.xz`, и сообщает
  о сбое команды вместе с её `stderr` — там `xz` и `tar` и говорят, что именно пошло не так.
  Эти решения закреплены тестами без базы (`test-pgvector.myrmidon.test.ts`), поэтому расширение
  ставится везде, где есть системный `xz`.
- Интеграционный стенд теперь повторяет и индексы миграции, а не только колонки. SQL поиска
  соединяет чанки с документами по `document_id` и отбирает документы по `(dataset_id, status)`,
  и стенд без этих btree-индексов заставил планировщик ответить вложенным циклом, который
  сканировал все чанки для каждого документа: в CI это был план на 789 мс на стенде из 2000
  чанков с `Rows Removed by Join Filter: 4000000` — форма, которую боевая база никогда не выберет,
  и задержка, описывавшая стенд, а не продукт. Теперь схема зонда создаёт четыре btree-индекса
  таблиц миграции, страж без базы падает, если хоть один пропал или перестал покрывать
  соединяемые и отбираемые колонки, а тест плана падает, если этот взрыв соединения вернётся.
- Это кодовая половина шага корпуса; подключение модуля к маршрутам, настройкам и интерфейсу —
  в следующих частях CORPUS-2.0.