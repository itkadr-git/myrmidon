## changelog-en

### Corpus search: vector ranking through the HNSW iterative scan, shorter substring match (1.6.6 OPE-12034)

- The vector ranking of the corpus search no longer loses candidates to the dataset filter. The index
  knows the company, not the dataset, so the old statement returned only the chunks of the dataset
  among the 64 rows the index scan reached (on production 51 of the 100 requested candidates per call
  on average). With pgvector 0.8 the search now runs with the HNSW iterative scan
  (`hnsw.iterative_scan = relaxed_order`), which keeps scanning until the limit is filled, and sorts
  the rows by score; the scan may visit up to 100 000 index tuples (`hnsw.max_scan_tuples`; pgvector's
  own 20 000 left a question far from work-craft with 47 to 67 of the 100 candidates). A dataset of up
  to 10 000 embedded chunks is ranked exactly over its own chunks
  instead (milliseconds, where the index scan has to walk far to find a few of them). With pgvector
  before 0.8 the search keeps the previous statement; the version is read from `pg_extension` (one lookup
  per search) instead of being tried with `SET`, so no failed `SET` can abort the transaction.
- The full-text ranking adds the `ILIKE '%…%'` trigram match only for query texts of up to 16
  characters (`ilikeMaxLength`) and for an identifier, a single token without whitespace of up to 64
  characters (a file name, a version, a task code), which the `tsvector` does not find. On a long
  question the trigram index reads one posting list per
  trigram of the pattern: a cold run took 0.3 to 1.2 s on production for a match that did not add
  a single row to the 16 long questions measured, while the `tsvector` match alone takes
  milliseconds. Other longer texts are matched by the `tsvector` only.
- No migration and no setting: the limits are options of `createPostgresSearchIndex`
  (`exactSetMaxChunks`, `ilikeMaxLength`, `maxScanTuples`).

## changelog-ru

### Поиск по корпусу: векторная ветка через итеративный скан HNSW, более короткое подстрочное совпадение (1.6.6 OPE-12034)

- Векторная ветка поиска по корпусу больше не теряет кандидатов на фильтре набора. Индекс знает
  компанию, но не набор, поэтому прежний запрос возвращал лишь чанки набора из тех 64 строк, до
  которых дошёл скан (на бою в среднем 51 из 100 запрошенных кандидатов на вызов). На pgvector 0.8
  поиск теперь идёт с итеративным сканом HNSW (`hnsw.iterative_scan = relaxed_order`), который
  сканирует дальше, пока лимит не заполнен, и сортирует строки по близости; скан может обойти до
  100 000 кортежей индекса (`hnsw.max_scan_tuples`; стандартные 20 000 оставляли вопрос, далёкий от
  work-craft, с 47–67 из 100 кандидатов). Набор до 10 000 чанков
  с эмбеддингом ранжируется точно по своим чанкам (миллисекунды, тогда как скану индекса пришлось бы
  далеко идти за несколькими из них). На pgvector до 0.8 остаётся прежний запрос; версия читается
  на каждый поиск из `pg_extension` (один дешёвый запрос), а не пробуется через `SET`, поэтому
  отказавший `SET` не может оборвать транзакцию.
- Полнотекстовая ветка добавляет триграммное совпадение `ILIKE '%…%'` только для текстов запроса до
  16 символов (`ilikeMaxLength`) и для идентификатора, то есть одного слова без пробелов до 64
  символов (имя файла, версия, код задачи), которого `tsvector` не находит. На длинном вопросе индекс
  триграмм читает по списку на каждую
  триграмму шаблона: на холодном индексе это стоило 0,3–1,2 с на бою ради совпадения, которое не
  добавило ни одной строки ни для одного из 16 измеренных длинных вопросов, а одно совпадение по
  `tsvector` занимает миллисекунды. Прочие более длинные тексты ищутся только по `tsvector`.
- Миграций и настроек нет: пределы — параметры `createPostgresSearchIndex`
  (`exactSetMaxChunks`, `ilikeMaxLength`, `maxScanTuples`).
