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

Run from the repository root:

```sh
pnpm --filter @myrmidon/server corpus:import:ragflow
```

The importer first enumerates source datasets/documents and obtains RAGFlow's declared document and chunk totals (stream-counting chunks where RAGFlow omits a total). It checks these before any database writes or embedding calls. A source/count mismatch aborts preflight; investigate pagination, source consistency and tolerance rather than bypassing the check.

Each progress record and the final summary are JSON lines on stdout. `embedded` counts newly requested vectors; `reused` counts matching valid stored vectors reused on resume. The summary includes elapsed milliseconds. Keep the complete run output in approved restricted operational logs and compare dataset/document/chunk totals and vector coverage with the RAGFlow source before declaring acceptance.

If a run fails, fix the underlying connectivity/capacity issue and rerun with the same company, source and model. Matching chunks/vectors are reused; changed chunk content or model is re-embedded. Do not clean or truncate corpus tables to resume.

## Acceptance and rollback

Before using the corpus as the bot search source, verify all intended datasets are present, document and chunk totals match the source within the agreed tolerance, every imported chunk has a valid 1024-dimensional vector, and elapsed time is recorded. Then follow the separately approved offline search comparison and cutover procedure. Keep RAGFlow available as the agreed rollback until that procedure's observation window passes; this importer does not switch bots or remove RAGFlow.

The importer stores the authenticated RAGFlow document-record API URL as `source_uri`; it does not download source files or calculate a source-file hash.
