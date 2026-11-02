## changelog-en

### Corpus indexing sends embeddings in batches with a timeout (1.6.6 CORPUS-2.0)

- The embedder of the corpus module no longer sends all chunks of a document in one
  request. It sends them in sequential batches of 64 texts and keeps the order of the
  vectors. Cloud embedding endpoints cap the inputs per request and answer a very large
  request slowly, so a long document (thousands of chunks) failed to index before.
- Every embedding request now has a timeout of 120 seconds. The secret that holds the
  embedder key is still resolved once per call, not once per batch. A failed batch fails
  the document as before, and the parse worker retries it. Search sends one text and is
  otherwise unchanged.

## changelog-ru

### Индексация корпуса отправляет эмбеддинги пачками и с таймаутом (1.6.6 CORPUS-2.0)

- Эмбеддер модуля корпуса больше не отправляет все чанки документа одним запросом.
  Он шлёт их последовательными пачками по 64 текста и сохраняет порядок векторов.
  Облачные эндпоинты эмбеддингов ограничивают число входов в запросе, а очень большой
  запрос обрабатывают медленно, поэтому длинный документ (тысячи чанков) раньше не
  индексировался.
- У каждого запроса эмбеддингов теперь таймаут 120 секунд. Секрет с ключом эмбеддера
  по-прежнему читается один раз на вызов, а не на каждую пачку. Ошибка пачки, как и
  раньше, роняет документ, и воркер разбора повторяет его. Поиск шлёт один текст и в
  остальном не изменился.
