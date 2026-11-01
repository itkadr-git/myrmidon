# Importing the corpus from RAGFlow

This runbook copies the already parsed datasets, documents and chunks from RAGFlow into the company's `corpus_*` tables. It does not fetch original file bytes or parse documents again. Stable IDs and conflict-safe upserts allow a failed import to resume.

## Before running

- Confirm the target release has the corpus schema and that `CORPUS_COMPANY_ID` is the intended company.
- Ensure the company's search embedder uses `hindsight-embed-bge-m3` at 1024 dimensions, matching the import model and the `vector(1024)` storage. Do not switch only one side: vectors from a different model are not comparable.
- Obtain credentials through the approved runtime secret store. Never put API keys in shell history, command arguments, logs or issue comments.
- Verify RAGFlow read access, database connectivity and the LiteLLM embedding route before starting the full corpus.

## Required environment

Set `RAGFLOW_BASE_URL`, `RAGFLOW_API_KEY`, `DATABASE_URL`, `CORPUS_COMPANY_ID`, `LITELLM_BASE_URL` and `LITELLM_API_KEY` in the approved runtime environment. `CORPUS_EMBEDDING_MODEL` defaults to `hindsight-embed-bge-m3`; `CORPUS_EMBEDDING_DIMENSIONS` defaults to `1024` and any other dimension is rejected. The model name must resolve in the configured LiteLLM gateway to the approved bge-m3 deployment.

Optional tuning: `CORPUS_IMPORT_BATCH_SIZE`, `CORPUS_IMPORT_CONCURRENCY`, and `CORPUS_CHUNK_COUNT_TOLERANCE` (default `0.01`). Start with defaults and change concurrency only with gateway capacity confirmed.

## Run and resume

The importer CLI is included in the production runtime container image and is runnable directly with plain Node without development-only `tsx`.

### 1. Read-only preflight (`--dry-run`)

Before running a full import or embedding generation, execute a read-only `--dry-run`. This inspects RAGFlow datasets, documents, and chunks, validates chunk counts against declared totals, and checks existing PostgreSQL corpus chunk states to report embedding coverage:

```sh
# Inside the built runtime container image (/app/server):
node dist/scripts/ragflow-corpus-import.js --dry-run

# Or via pnpm in the server package:
pnpm --filter @myrmidon/server corpus:import:ragflow:dry-run
```

Dry-run characteristics:
- Requires only `RAGFLOW_BASE_URL`, `RAGFLOW_API_KEY`, `DATABASE_URL`, and `CORPUS_COMPANY_ID`.
- Does NOT require `LITELLM_BASE_URL` or `LITELLM_API_KEY`.
- Generates ZERO embeddings and performs ZERO writes to the database.
- Outputs structured progress and a final JSON report detailing:
  - Source datasets and documents count.
  - Total enumerated chunks.
  - Embedding coverage breakdown (`reusableChunks`, `missingChunks`, `coverageRatio`).

### 2. Full production import

Once dry-run verification succeeds and LiteLLM gateway capacity is confirmed, run the full import:

```sh
# Inside the built runtime container image (/app/server):
node dist/scripts/ragflow-corpus-import.js

# Or via pnpm:
pnpm --filter @myrmidon/server corpus:import:ragflow
```

### Safe resumability

The importer is fully idempotent and safely resumable:
- Chunk IDs are deterministic UUIDs computed from `[companyId, datasetId, documentId, sourceChunkId || index]`.
- Chunks in the database store `content`, `embedding`, `embeddingModel`, `embeddingDimensions`, and `embeddingContentHash`.
- During import, existing chunk states are queried in batches. Any chunk with an existing normalized embedding matching the configured model, dimensions, and SHA-256 content hash is reused without calling LiteLLM.
- If an import process terminates or fails mid-run, re-running with the same company and model will pick up where it left off, skipping already embedded chunks and processing only missing or updated chunks. Do not drop or truncate corpus tables to resume.

## Acceptance and rollback

Before using the corpus as the bot search source, verify all intended datasets are present, document and chunk totals match the source within the agreed tolerance, every imported chunk has a valid 1024-dimensional vector, and elapsed time is recorded. Then follow the separately approved offline search comparison and cutover procedure. Keep RAGFlow available as the agreed rollback until that procedure's observation window passes; this importer does not switch bots or remove RAGFlow.

The importer stores the authenticated RAGFlow document-record API URL as `source_uri`; it does not download source files or calculate a source-file hash.
