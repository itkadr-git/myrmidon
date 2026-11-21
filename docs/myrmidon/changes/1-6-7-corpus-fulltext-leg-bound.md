## changelog-en

### Corpus: the full-text part of a search has a time bound, and the two parts run side by side (1.6.7 CORPUS-SEARCH)

- A search of the knowledge corpus ranks chunks twice: by vector distance and by full text. The full-text
  part of a natural-language question matched a large part of a big corpus and scored every match, and it
  also computed a trigram `similarity` over the whole text of every match. On a corpus of 285 000 chunks
  it took 9.8 s on average and up to 104 s, while the vector part took 0.4 s.
- The full-text part now runs in its own transaction with `statement_timeout` of 800 ms (new option
  `fullTextTimeoutMs`; `0` sets no bound of its own). When the server cancels it, the search answers from
  the vector part alone, and the server log gets a warning with the company, the datasets, the length of
  the query text and the time used. Every other error is still an error. A search that has no vector
  part (a text-only search) has nothing to fall back on, so it returns the cancel error and not an empty
  list.
- The vector part and the full-text part run at the same time, each in its own transaction on its own
  pooled connection, so a search takes the longer of the two and not their sum. A search holds two
  connections while it runs.
- For a question without the substring match, `similarity` now runs only over the best 1 000 chunks by
  `ts_rank` (new option `fullTextRerankPool`; `0` brings the old statement back). Short query texts and
  identifiers keep their statement and their order.

## changelog-ru

### Корпус: полнотекстовая часть поиска ограничена по времени, обе части идут одновременно (1.6.7 CORPUS-SEARCH)

- Поиск по базе знаний ранжирует фрагменты дважды: по векторному расстоянию и по полному тексту.
  Полнотекстовая часть для вопроса на естественном языке совпадала с большой долей крупного корпуса,
  оценивала каждое совпадение и ещё считала триграммное `similarity` по всему тексту каждого совпавшего
  фрагмента. На корпусе из 285 тысяч фрагментов она занимала в среднем 9,8 с и до 104 с, а векторная
  часть — 0,4 с.
- Теперь полнотекстовая часть идёт в своей транзакции с `statement_timeout` 800 мс (новая опция
  `fullTextTimeoutMs`; `0` — собственного ограничения нет). Если сервер её отменяет, поиск отвечает по
  одной векторной части, а в журнале сервера появляется предупреждение с компанией, наборами, длиной
  текста запроса и затраченным временем. Любая другая ошибка по-прежнему остаётся ошибкой. У поиска без
  векторной части (только по тексту) запасного ранжирования нет, поэтому он возвращает ошибку отмены, а
  не пустой список.
- Векторная и полнотекстовая части идут одновременно, каждая в своей транзакции на своём соединении
  из пула, поэтому поиск занимает время более долгой из них, а не сумму. Пока поиск идёт, он держит два
  соединения.
- Для вопроса без поиска подстроки `similarity` теперь считается только по лучшим 1000 фрагментов по
  `ts_rank` (новая опция `fullTextRerankPool`; `0` возвращает прежний запрос). Короткие тексты запроса и
  идентификаторы сохраняют свой запрос и свой порядок.
