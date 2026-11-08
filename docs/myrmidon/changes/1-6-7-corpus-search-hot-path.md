---
settings-section: 1.6.6 — CORPUS-2.0 C: knowledge corpus server side
---

## changelog-en

### Corpus: a search no longer counts every dataset, and a repeated question reuses its vector (1.6.7 CORPUS-LATENCY, OPE-12272)

- The `corpus_search` tool (the route the agents use) called the same store read as `corpus_list_datasets`
  on every search. That read counts the documents and the chunks of every dataset of the company, to get
  the id and the name of each dataset. On a corpus of hundreds of thousands of chunks it took 3 to 5 s, so
  the agent route was about 3 s slower than the REST search of one dataset. The search now reads only the
  ids and names (new store port method `listDatasetNames`, one query with no counters). The answer of the
  search does not change: the same datasets, the same hits, the same `datasetName` in each hit. The tools
  `corpus_get_document` and `corpus_list_documents` also take the dataset name from this read and no
  longer count the dataset.
- The dataset list with its counters (`corpus_list_datasets`, the board screen, the shadow search) is kept
  per company for 60 s. A write through the corpus ports (dataset, document or chunk change) drops the
  list of that company at once, so an upload, a parse result or a delete shows in the list without
  waiting. A change made outside the board process (an import script on its own connection) shows after
  at most the TTL. The counters of one dataset (`getDataset`) no longer load every document row to count
  the documents: the count is the sum of the per-status counts that the same read already had.
- The vector of a search question is kept for 600 s (was 60 s) and for at most 512 questions (was 128),
  so a repeated question, for example a run of a golden set, does not call the embedder again. The key is
  the company, the embedder (base URL, model, dimensions) and the exact text of the question. Identical
  questions in flight at the same time share one embedder call. A failed embedder call is never kept.
- Two new settings, both in seconds: `MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC` and
  `MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC`. `0` turns the matching cache off.

## changelog-ru

### Корпус: поиск больше не считает все наборы, а повторный вопрос использует прежний вектор (1.6.7 CORPUS-LATENCY, OPE-12272)

- Инструмент `corpus_search` (маршрут, которым ходят агенты) на каждом поиске вызывал то же чтение
  хранилища, что и `corpus_list_datasets`. Оно считает документы и фрагменты в каждом наборе компании,
  хотя поиску нужны только идентификатор и имя набора. На корпусе из сотен тысяч фрагментов это занимало
  от 3 до 5 с, поэтому маршрут агентов был примерно на 3 с медленнее поиска REST по одному набору. Теперь
  поиск читает только идентификаторы и имена (новый метод порта хранилища `listDatasetNames`, один запрос
  без подсчётов). Ответ поиска не меняется: те же наборы, те же фрагменты, то же `datasetName` в каждом
  найденном фрагменте. Инструменты `corpus_get_document` и `corpus_list_documents` тоже берут имя набора
  из этого чтения и больше не считают набор.
- Список наборов со счётчиками (`corpus_list_datasets`, экран доски, теневой поиск) хранится по компании
  60 с. Любая запись через порты корпуса (изменение набора, документа или фрагментов) сразу сбрасывает
  список этой компании, поэтому загрузка, результат разбора или удаление видны в списке без ожидания.
  Изменение вне процесса доски (скрипт импорта на своём соединении) видно не позже чем через TTL.
  Счётчики одного набора (`getDataset`) больше не загружают все строки документов, чтобы их посчитать:
  число документов — сумма счётчиков по статусам, которые то же чтение уже получало.
- Вектор вопроса поиска хранится 600 с (было 60 с), не более чем для 512 вопросов (было 128), поэтому
  повторный вопрос, например прогон золотого набора, не вызывает эмбеддер заново. Ключ — компания,
  эмбеддер (адрес, модель, размерность) и точный текст вопроса. Одинаковые вопросы, идущие одновременно,
  делят один вызов эмбеддера. Неудавшийся вызов эмбеддера не запоминается.
- Две новые настройки, обе в секундах: `MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC` и
  `MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC`. `0` выключает соответствующий кэш.

## settings-en

| `MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `600` | How many seconds the vector of a search question is reused, so the same question does not call the embedder again (up to 512 questions; the key is the company, the embedder base URL, model, dimensions and the exact text). Identical questions in flight share one embedder call. Read when a search starts, so a change needs no restart | `0` turns the cache off: every search embeds its question. Unset, empty, non-numeric or negative - the default. Above `86400` - `86400` |
| `MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `60` | How many seconds the dataset list with its document and chunk counters (`corpus_list_datasets`, the board screen) is reused per company. A write through the corpus ports of the board process drops the list of that company at once; a change from another process shows after at most this many seconds. A search does not read this list | `0` turns the cache off: every list call counts again. Unset, empty, non-numeric or negative - the default. Above `86400` - `86400` |

## settings-ru

| `MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `600` | Сколько секунд вектор вопроса поиска используется повторно, чтобы тот же вопрос не вызывал эмбеддер заново (не более 512 вопросов; ключ — компания, адрес эмбеддера, модель, размерность и точный текст). Одинаковые вопросы, идущие одновременно, делят один вызов эмбеддера. Читается при начале поиска, поэтому изменение не требует перезапуска | `0` выключает кэш: каждый поиск строит вектор вопроса заново. Не задано, пусто, не число или отрицательное — значение по умолчанию. Больше `86400` — `86400` |
| `MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `60` | Сколько секунд список наборов со счётчиками документов и фрагментов (`corpus_list_datasets`, экран доски) используется повторно по компании. Запись через порты корпуса в процессе доски сразу сбрасывает список этой компании; изменение из другого процесса видно не позже чем через это число секунд. Поиск этот список не читает | `0` выключает кэш: каждый вызов списка считает заново. Не задано, пусто, не число или отрицательное — значение по умолчанию. Больше `86400` — `86400` |
