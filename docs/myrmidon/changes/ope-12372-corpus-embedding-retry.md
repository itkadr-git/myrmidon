## changelog-en

### Corpus: embedding gateway retry and hybrid vector search resilience for cold query p95 < 2s (OPE-12372)

- Added 1 retry with exponential backoff on transient embedding gateway failures/timeouts in `corpus_search` / embedder adapters to eliminate embedding tail latency spikes on cold questions.

## changelog-ru

### Корпус: повтор запросов эмбеддингов на шлюзе и оптимизация гибридного векторного поиска для p95 холодного вопроса < 2 с (OPE-12372)

- Добавлен повтор (1 попытка с экспоненциальной задержкой) при временных сбоях/таймаутах шлюза эмбеддингов в адаптерах `corpus_search`, что исключает скачки хвоста задержки эмбеддингов на холодных вопросах.
