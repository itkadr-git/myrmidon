## changelog-en

### Corpus search no longer loads every hit's chunks and jobs

One corpus search resolved each hit's document with a full read that also loaded the
document's chunks (embeddings included) and parse jobs, and the dataset check loaded every
document of the dataset (OPE-12272). Both are now one bounded company-scoped query (document
titles for the hits, dataset existence), and the search handler and the search index log
their step durations on the debug log (`corpus search: handler step timings`,
`corpus search: embed and index timings`), so a slow search can be attributed to the
embedding call or to the SQL.

## changelog-ru

### Поиск по корпусу больше не загружает фрагменты и задания каждого найденного документа

Один поиск по корпусу читал каждый найденный документ целиком — с фрагментами (вместе
с векторами) и заданиями разбора, а проверка набора загружала все документы набора
(OPE-12272). Теперь это один ограниченный запрос в пределах компании (названия документов
найденного, наличие набора), а обработчик поиска и поисковый индекс пишут длительность шагов
в отладочный журнал (`corpus search: handler step timings`, `corpus search: embed and index timings`),
так что медленный поиск можно отнести к вызову эмбеддера или к SQL.
