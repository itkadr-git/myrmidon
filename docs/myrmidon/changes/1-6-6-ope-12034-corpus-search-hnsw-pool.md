## changelog-en

### Corpus search: vector ranking through an HNSW pool, shorter substring match (1.6.6 OPE-12034)

- The vector ranking of the corpus search no longer filters an HNSW scan by dataset after the fact.
  The index knows the company, not the dataset, so the old statement returned only the few dozen
  chunks that the 64-row scan reached (on production 51 of the 100 requested candidates per call on
  average). With pgvector 0.8 the search now
  takes a pool of the nearest chunks of the company with the HNSW iterative scan
  (`hnsw.iterative_scan = relaxed_order`; `clamp(kCandidates * 8, 400, 2000)` rows), filters it by
  dataset and document status, and keeps the top `kCandidates`. A dataset of up to 10 000 embedded
  chunks, and a dataset whose pool share is below `kCandidates`, are ranked exactly over their own
  chunks instead. A search without a dataset takes the pool as it is. With pgvector before 0.8 the
  search keeps the previous statement; the version is read once per index, so no failed `SET`
  can abort the transaction.
- The full-text ranking adds the `ILIKE '%…%'` trigram match only for query texts of up to 16
  characters (`ilikeMaxLength`). On a long question the trigram index reads one posting list per
  trigram of the pattern: a cold run took 0.3 to 1.2 s on production for a match that did not add
  a single row to the 16 long questions measured, while the `tsvector` match alone takes
  milliseconds. Longer texts are matched by the
  `tsvector` only.
- No migration and no setting: both limits are options of `createPostgresSearchIndex`
  (`exactSetMaxChunks`, `ilikeMaxLength`).

## changelog-ru

### Поиск по корпусу: векторная ветка через пул HNSW, более короткое подстрочное совпадение (1.6.6 OPE-12034)

- Векторная ветка поиска по корпусу больше не фильтрует скан HNSW по набору постфактум. Индекс
  знает компанию, но не набор, поэтому прежний запрос возвращал лишь несколько десятков чанков,
  до которых дошёл скан из 64 строк (на бою в среднем 51 из 100 запрошенных кандидатов на вызов).
  На pgvector 0.8 поиск теперь берёт пул ближайших
  чанков компании итеративным сканом HNSW (`hnsw.iterative_scan = relaxed_order`;
  `clamp(kCandidates * 8, 400, 2000)` строк), фильтрует его по набору и статусу документа и
  оставляет `kCandidates` лучших. Набор до 10 000 чанков с эмбеддингом и набор, которого в пуле
  меньше `kCandidates`, ранжируются точно по своим чанкам. Поиск без набора берёт пул как есть. На
  pgvector до 0.8 остаётся прежний запрос; версия читается один раз на индекс, поэтому
  отказавший `SET` не может оборвать транзакцию.
- Полнотекстовая ветка добавляет триграммное совпадение `ILIKE '%…%'` только для текстов запроса до
  16 символов (`ilikeMaxLength`). На длинном вопросе индекс триграмм читает по списку на каждую
  триграмму шаблона: на холодном индексе это стоило 0,3–1,2 с на бою ради совпадения, которое не
  добавило ни одной строки ни для одного из 16 измеренных длинных вопросов, а одно совпадение по
  `tsvector` занимает миллисекунды. Тексты длиннее
  ищутся только по `tsvector`.
- Миграций и настроек нет: оба предела — параметры `createPostgresSearchIndex`
  (`exactSetMaxChunks`, `ilikeMaxLength`).
