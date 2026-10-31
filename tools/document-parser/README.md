# DocumentParser Adapter Tool

HTTP DocumentParser adapter for Docling-serve and knowledge corpus ingestion.

## Endpoints

- `POST /v1/parse`: Submits document payload `{ submissionId, fileName, mimeType, title, parserVersion, contentBase64 }`.
- `GET /v1/parse/{jobId}`: Polls document parse job `{ jobId, status, text, pages: [{ pageNumber, text }], error }`.
- `GET /health`: Health probe.

## Key Behavior

- **Docling adaptation**: proxies document conversion to docling-serve.
- **Chunk splitting**: automatically splits document text into pages/blocks with <= 1500 characters (`CHUNK_MAX_CHARS=1500`).
- **Format protection**: rejects unsupported EPUB and FB2 formats (`.epub`, `.fb2`, `application/epub+zip`, `application/x-fictionbook+xml`) with code `unsupported_format`.
- **Payload limit**: accepts payloads up to 150 MiB (`MAX_BODY_BYTES=157286400`) to support ~110 MiB binary base64 documents. Exceeding requests return HTTP 413 `payload_too_large`.
- **Retry safety**: idempotent submissions by `submissionId` — repeats return the existing job.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5001` | Listen port |
| `HOST` | `0.0.0.0` | Listen host |
| `DOCLING_SERVE_URL` | `http://127.0.0.1:5002` | Upstream docling-serve instance URL |
| `MAX_BODY_BYTES` | `157286400` (150 MiB) | Maximum allowed request body size |
| `MAX_FILE_BYTES` | `115343360` (110 MiB) | Maximum decoded file size |
| `CHUNK_MAX_CHARS` | `1500` | Maximum character length of each chunk/page |

## Production TEI & Parser Topology

In production (`docker/corpus/docker-compose.yml`), services are configured at:
- Parser: `http://172.22.0.1:5001`
- TEI Embeddings: `http://172.22.0.1:8090/v1` (with `--auto-truncate`, `--max-client-batch-size 2048`, `dimensions=1024`)
