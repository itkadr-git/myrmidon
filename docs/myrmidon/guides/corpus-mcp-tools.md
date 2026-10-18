# Corpus MCP tools for board bots

The board serves a company's knowledge corpus to its bots over its own MCP
endpoint, so a bot searches and reads the corpus with the board's own module
instead of the RAGFlow facade.

- Endpoint: `POST /api/myrmidon/companies/:companyId/corpus/mcp`
- Shape: JSON-RPC over HTTP (`initialize`, `tools/list`, `tools/call`), the same
  shape as the OCR endpoint a bot is already pointed at; protocol revision
  `2025-03-26`. Access is the company the path names (`assertCompanyAccess`), the
  same rule the rest of the company-scoped API uses.
- Tools: `corpus_search`, `corpus_get_document`, `corpus_list_datasets`,
  `corpus_list_documents`.

## Turning it on

The tools exist **with the module**: they follow `instance_settings.general.corpus`
(part C's settings block) and the switch is read on every call, so enabling or
disabling the corpus takes effect on the bot's next call with no restart.

- Module off: `tools/list` returns an empty list, and a `tools/call` that names a
  corpus tool anyway is answered as a tool result with `isError` and the code
  `corpus_disabled`. A bot whose configuration is older than the switch reports a
  sentence instead of failing to reach the endpoint.
- Module on, data side not wired: the tool surface is there and answers
  `corpus_unavailable` — the module is on, nothing is pretending the corpus is
  empty.
- The ceiling comes from the module settings: `top_k` (search) and `limit`
  (documents) above the configured maximum are refused, not clamped.

## The tools

### `corpus_search`

Find chunks by meaning. Arguments: `query` (required), `dataset` or
`dataset_ids` to restrict the search, `top_k` (default from the settings,
capped by them), `min_score` (alias `similarity_threshold`) to drop weak hits.
The answer is the list of chunks a shadow run compares: the chunk text, its
score, and the document it came from (id, name, page, link).

### `corpus_get_document`

Read one document: metadata, parse state, and — unless `include_text: false` —
its text assembled from the indexed chunks. Give it the document id a search
result reported.

### `corpus_list_datasets`

What there is to search in: the company's datasets with their document and chunk
counts. No arguments.

### `corpus_list_documents`

What is in a dataset, with each document's parse state (`queued`, `parsing`,
`embedding`, `ready`, `failed`), so a bot can tell whether a document is ready to
be searched. Arguments: `dataset`/`dataset_ids`, `offset` and `limit` (skipping
requires `limit`).

## Failures

Every failure is a tool result with a stable code a bot can act on:
`corpus_disabled`, `corpus_unavailable`, `invalid_tool_input`,
`dataset_not_found`, `document_not_found`, `query_failed`.

## What this endpoint does not do

It reads only. Ingesting, parsing and embedding documents belong to parts A–C of
the corpus module (their routes, their screen); replacing the RAGFlow facade in a
bot's configuration is part E's and the operator's step. Running both paths on the
same requests — the shadow comparison — is what the RAGFlow-compatible argument
aliases above are for: `corpus_search` accepts `dataset_ids` and
`similarity_threshold` beside `dataset` and `min_score`, so one request body
serves both.