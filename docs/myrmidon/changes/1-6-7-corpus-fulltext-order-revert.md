## changelog-en

### Corpus: the full-text ranking starts after the embedding again (1.6.7 CORPUS-LATENCY, OPE-12272)

- The change "the full-text ranking starts together with the embedding" is taken back. The full-text
  ranking has a time bound of 800 ms. When it started first, the bound ran out while the question was
  still being embedded, and whether the ranking finished in time or was cancelled depended on a race with
  the embedding and with the load of the database. The top 5 of the same question then changed between
  identical runs (21 of 70 questions of the golden set, against 5 before), and hit@5 of the cold run fell
  to 57 of 70 (the limit is 58).
- A search embeds the question first and then starts the vector and the full-text ranking side by side, as
  it did in the full-text bound change. `CorpusSearchQuery.embedding` is a plain vector again.
- Kept from the same change: the cache of the resolved embedder key
  (`MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`) and the sampled step timings on the info log
  (`MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`).

## changelog-ru

### Корпус: полнотекстовая часть снова стартует после эмбеддинга (1.6.7 CORPUS-LATENCY, OPE-12272)

- Изменение «полнотекстовая часть стартует вместе с эмбеддингом» отменено. У полнотекстовой части есть
  граница по времени 800 мс. Когда она стартовала первой, граница истекала, пока вопрос ещё
  встраивался, и то, успела ли часть завершиться или была отменена, зависело от гонки с эмбеддингом и от
  нагрузки на базу. Топ-5 одного и того же вопроса менялся между одинаковыми прогонами (21 вопрос из 70
  золотого набора против 5 прежде), а hit@5 холодного прогона упал до 57 из 70 (порог 58).
- Поиск сначала встраивает вопрос и только потом запускает векторную и полнотекстовую части одновременно,
  как это было в изменении границы полнотекстовой части. `CorpusSearchQuery.embedding` снова обычный
  вектор.
- Из того же изменения сохранены кэш разрешённого ключа эмбеддера
  (`MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`) и выборка таймингов шагов в info-журнале
  (`MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`).
