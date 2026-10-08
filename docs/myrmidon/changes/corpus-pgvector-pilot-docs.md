## changelog-en

### Knowledge corpus pilot: pgvector search matches RAGFlow (CORPUS-2.0 step 3)

- The step 3 pilot of the corpus epic measured retrieval on PostgreSQL +
  pgvector against the RAGFlow baseline: recall@5 0.8429 vs 0.829, nDCG@10
  0.7056 vs 0.663, p95 search latency ~0.1 s vs ~15 s (gate p95 < 2 s passed
  with a wide margin). Recommendation for the future corpus module: DashScope
  `text-embedding-v4` (1024 dimensions) via the LiteLLM gateway, HNSW index
  (`m = 16`, `ef_construction = 64`, `ef_search = 64`), hybrid retrieval with
  RRF (`k0 = 60`, `k_candidates = 100`) and a `pg_trgm` GIN full-text index;
  embedding cost ~$1.64 per 100,000 chunks. The pilot ran outside the product
  and changes nothing in this build; the record and the decision are in
  [design/corpus-pgvector-pilot.md](design/corpus-pgvector-pilot.md).

## changelog-ru

### Пилот корпуса знаний: поиск на pgvector на уровне RAGFlow (CORPUS-2.0, шаг 3)

- Пилот третьего шага эпика корпуса измерил поиск на PostgreSQL + pgvector
  против базовой RAGFlow: recall@5 — 0.8429 против 0.829, nDCG@10 — 0.7056
  против 0.663, задержка поиска p95 — ~0.1 с против ~15 с (порог p95 < 2 с
  пройден с большим запасом). Рекомендация для будущего модуля корпуса:
  DashScope `text-embedding-v4` (размерность 1024) через шлюз LiteLLM, индекс
  HNSW (`m = 16`, `ef_construction = 64`, `ef_search = 64`), гибридный поиск с
  RRF (`k0 = 60`, `k_candidates = 100`) и полнотекстовый индекс GIN по
  `pg_trgm`; стоимость эмбеддинга — ~$1.64 за 100 000 чанков. Пилот шёл вне
  продукта и в этой сборке ничего не меняет; запись и решение — в
  [design/corpus-pgvector-pilot.ru.md](design/corpus-pgvector-pilot.ru.md).
