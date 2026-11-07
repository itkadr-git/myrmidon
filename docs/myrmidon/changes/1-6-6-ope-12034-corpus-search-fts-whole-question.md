## changelog-en

### Corpus search: the full-text leg keeps the question as a whole next to the OR of its words; a small company is ranked exactly (1.6.6 OPE-12034)

- The full-text ranking matches `plainto_tsquery(question) || to_tsquery(OR of significant words)`.
  The OR alone, which replaced the all-words match so that a natural-language question finds
  something, drops numbers and words shorter than 4 characters: a question that names a chunk by its
  number or code matched every chunk that shares the other words, and the chunk was lost in the
  tie (the hybrid recall of the integration suite fell from 1.00 to 0.85). The question taken as a
  whole singles such a chunk out, and `ts_rank` puts it first. The tie-break by `similarity` uses the
  question as written, not the OR string. The statement no longer raises a "query doesn't contain
  lexemes" notice for a question with no significant word.
- A search that names no dataset probes the company the same way a dataset search probes its
  dataset: a company of up to 10 000 embedded chunks (`exactSetMaxChunks`) is ranked exactly, a
  larger one goes through the HNSW iterative scan.

## changelog-ru

### Поиск по корпусу: полнотекстовая ветка сохраняет вопрос целиком рядом с OR его слов; малая компания ранжируется точно (1.6.6 OPE-12034)

- Полнотекстовое ранжирование ищет по `plainto_tsquery(вопрос) || to_tsquery(OR значимых слов)`.
  Один OR, заменивший совпадение по всем словам, чтобы вопрос естественного языка хоть что-то
  находил, теряет числа и слова короче 4 символов: вопрос, называющий чанк по номеру или коду,
  совпадал со всеми чанками с остальными словами, и нужный чанк тонул в равных рангах (гибридный
  recall интеграционного набора упал с 1,00 до 0,85). Вопрос целиком выделяет такой чанк, а
  `ts_rank` ставит его первым. Разбор ничьих по `similarity` идёт по вопросу как он написан, а не по
  строке OR. Запрос больше не поднимает предупреждение «query doesn't contain lexemes», если в
  вопросе нет значимых слов.
- Поиск без набора проверяет размер компании так же, как поиск по набору проверяет размер набора:
  компания до 10 000 чанков с эмбеддингом (`exactSetMaxChunks`) ранжируется точно, большая идёт
  через итеративный скан HNSW.
