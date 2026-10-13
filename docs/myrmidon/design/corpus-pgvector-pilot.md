# Knowledge corpus pilot: search on PostgreSQL + pgvector — results and decision

> Russian version: [corpus-pgvector-pilot.ru.md](corpus-pgvector-pilot.ru.md)

Revision of 08.10.2026. This document records the outcome of the CORPUS-2.0
step 3 pilot: whether the platform's knowledge corpus (retrieval for agent
memory and documents) can move from the external RAGFlow service to an index
inside the platform's own PostgreSQL with the pgvector extension. The pilot is
a measurement, not a product feature — nothing in the shipped build changes,
and this page is the durable record behind the recommendation.

## 0. Summary

- Search on PostgreSQL + pgvector is **not worse than RAGFlow** on the pilot
  corpus, and is two orders of magnitude faster: recall@5 0.8429 vs the
  RAGFlow baseline 0.829, nDCG@10 0.7056 vs 0.663; p95 search latency ~0.1 s
  vs ~15 s. The pilot's acceptance gate was p95 < 2 s — passed with a wide
  margin.
- Recommendation for the future corpus module (the implementation is a
  separate epic item, not this pilot):
  - embedder: DashScope `text-embedding-v4` at 1024 dimensions, called through
    the LiteLLM gateway;
  - vector index: HNSW with `m = 16`, `ef_construction = 64`,
    `ef_search = 64`;
  - hybrid retrieval: reciprocal rank fusion with `k0 = 60`,
    `k_candidates = 100`; full-text side on a `pg_trgm` GIN index.
- Embedding cost at pilot prices: about **$1.64 per 100,000 chunks**.

## 1. Context

The corpus epic replaces RAGFlow with an own TypeScript retrieval module.
Step 3 of the epic was a pilot with one question to answer by measurement: can
PostgreSQL + pgvector carry the corpus index with quality and latency at least
as good as the RAGFlow service in use today? The pilot ran outside the product
repository, in an internal tooling repository (stand, embedder runner, and
quality harness under `corpus-pilot/`), so no product code or settings changed
in this step.

## 2. Measured results

| Metric | pgvector stand | RAGFlow baseline |
| --- | --- | --- |
| recall@5 | 0.8429 | 0.829 |
| nDCG@10 | 0.7056 | 0.663 |
| Search latency, p95 | ~0.1 s | ~15 s |

- Scale of the stand: on the order of 100,000 chunks.
- Latency gate for the pilot: p95 < 2 s — passed with a wide margin (~0.1 s).

## 3. Recommended configuration

| Component | Choice |
| --- | --- |
| Embedder | DashScope `text-embedding-v4`, 1024 dimensions, via the LiteLLM gateway |
| Vector index | pgvector HNSW: `m = 16`, `ef_construction = 64`, `ef_search = 64` |
| Hybrid fusion | Reciprocal rank fusion (RRF), `k0 = 60`, `k_candidates = 100` |
| Full-text side | `pg_trgm` trigram GIN index |

Embedding cost at the pilot's prices: ~$1.64 per 100,000 chunks.

## 4. Deviation from the original specification

The step specification named `text-embedding-v4` as the embedder from the
start. When the embedder stage began, the model was not routed in the LiteLLM
gateway (calls returned HTTP 400), so the stage ran on the fallback embedder
the runner was built with. On 07.10.2026 the model was added to the gateway
and the full quality run was repeated on `text-embedding-v4` — the numbers in
section 2 are the v4 results. The pilot runner selects the embedder through
the `EMBED_MODEL` environment variable, so the switch needed no code change.

## 5. Decision

The pilot's question is answered: the corpus index can live in the platform's
own PostgreSQL with pgvector without a quality or latency regression against
RAGFlow. The recommendation in section 3 is the input to the corpus-module
implementation item of the epic; until that item ships, RAGFlow remains the
production retrieval path and this page records why.
