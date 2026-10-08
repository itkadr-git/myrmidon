## changelog-en

### Knowledge corpus in code: hybrid search index and document parser client (CORPUS-2.0 step 4)

- `packages/corpus` gains the search half of the module: `createPostgresSearchIndex`
  implements the `SearchIndex` port as the pilot measured it — vector ranking over an HNSW
  index with `ef_search = 64` on L2-normalized 1024-dimension embeddings, full-text ranking
  over a `tsvector` column with a `pg_trgm` GIN index, both filtered by company and dataset
  and merged by reciprocal rank fusion (`k0 = 60`, `k_candidates = 100`). Every hit carries
  `score`, `chunk`, `document` and both source ranks; the fused order is deterministic.
- Document ingestion is wired end to end behind ports: sliding-window chunking (300–1500
  characters, 150 characters of overlap, boundaries on line breaks, configurable), batch
  embedding through the gateway, content-addressed `chunk_id`, and an idempotent write of the
  chunks. A gateway failure fails the batch with a retryable/permanent flag instead of
  half-writing it.
- `createDocumentParserClient` talks to the separate document-parsing service over HTTP
  (submit, poll, timeouts, retries) and reports failures as a typed outcome with a
  `retryable` flag instead of throwing, so a broken parser turns into a failed job the work
  queue retries rather than a crashed worker. The wire contract is typed and written down in
  the package README.
- Tests: fusion, vector helpers, chunker boundaries and `chunk_id` idempotency, the ingestion
  pipeline, the parser client against a mock server, and an embedded-PostgreSQL integration
  test that measures recall@5 and p95 latency on a synthetic corpus (skips with a printed
  reason when the stand has no `vector` extension). The search path is unit-tested through a
  recording SQL executor, so it needs no database.
- This is the code half of the corpus step; wiring the module to routes, settings and the UI
  follows in the later parts of CORPUS-2.0.

## changelog-ru

### Корпус знаний в коде: гибридный поиск и клиент разбора документов (CORPUS-2.0, шаг 4)

- В `packages/corpus` появилась поисковая половина модуля: `createPostgresSearchIndex`
  реализует порт `SearchIndex` так, как это измерил пилот — векторный поиск по индексу HNSW
  с `ef_search = 64` по L2-нормализованным эмбеддингам размерности 1024, полнотекстовый
  поиск по колонке `tsvector` с индексом GIN по `pg_trgm`, оба с фильтром по компании и
  датасету и слиянием через reciprocal rank fusion (`k0 = 60`, `k_candidates = 100`). Каждая
  находка несёт `score`, `chunk`, `document` и оба исходных ранга; порядок после слияния
  детерминирован.
- Конвейер загрузки документов собран целиком за портами: чанкинг скользящим окном
  (300–1500 знаков, перекрытие 150, границы по переводам строк, конфигурируемо),
  батч-эмбеддинг через шлюз, `chunk_id` из содержимого и идемпотентная запись чанков. Сбой
  шлюза проваливает батч с признаком «повторяемо/навсегда», а не пишет его наполовину.
- `createDocumentParserClient` общается с отдельным сервисом разбора по HTTP (отправка,
  поллинг, таймауты, повторы) и сообщает о сбоях типизированным результатом с признаком
  `retryable` вместо исключения: сломанный сервис разбора превращается в failed-джобу,
  которую очередь повторит, а не в падение воркера. Контракт запроса и ответа
  зафиксирован типами и описан в README пакета.
- Тесты: слияние RRF, векторные помощники, границы окон чанкера и идемпотентность
  `chunk_id`, конвейер загрузки, клиент разбора против мок-сервера и интеграционный тест на
  embedded-PostgreSQL, который замеряет recall@5 и p95 на синтетическом корпусе (пропускается
  с печатью причины, если на стенде нет расширения `vector`). Поисковый путь покрыт юнит-тестами
  через записывающий исполнитель SQL и базы не требует.
- Это кодовая половина шага корпуса; подключение модуля к маршрутам, настройкам и интерфейсу —
  в следующих частях CORPUS-2.0.