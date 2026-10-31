# Corpus Runtime Services (TEI + Docling + DocumentParser Adapter)

Production runtime configuration for knowledge corpus ingestion and search (1.6.6 CORPUS-2.0 / OPE-10169).

## Architecture & Addresses

Services run in Docker and are published to host/bridge gateway `172.22.0.1` and `paperclip_default` network:

| Service | Address | Purpose |
|---|---|---|
| **TEI (Embeddings)** | `http://172.22.0.1:8090/v1` | OpenAI-compatible `/v1/embeddings`, dimensions=1024, auto-truncate, batch >= 2048 |
| **DocumentParser Adapter** | `http://172.22.0.1:5001` | HTTP adapter: `POST /v1/parse`, `GET /v1/parse/{jobId}`, docling proxy, chunk <= 1500 chars |
| **Docling-Serve** | `http://docling-serve:5001` (internal) | Internal document converter behind adapter (PDF, DOCX, XLSX, HTML, images) |

> **Note on Addresses:** Services are reachable by the board application from the `paperclip_default` container network via `http://172.22.0.1:8090/v1` and `http://172.22.0.1:5001` without `localhost`.

---

## TEI Production Configuration

TEI runs `ghcr.io/huggingface/text-embeddings-inference:cpu-1.5` with model `BAAI/bge-m3` (1024 dimensions):
- `--auto-truncate`: automatically truncates inputs exceeding model context length instead of failing requests.
- `--max-client-batch-size 2048`: accepts batch submissions of 1000+ items without the default 256 item limit error.
- `--max-batch-tokens 16384`: bounds batch token processing to keep memory predictable and avoid OOM.
- `--max-concurrent-requests 8`: bounds concurrency to prevent worker thrashing.
- `mem_limit: 4g`: enforces container memory boundary.

---

## DocumentParser Adapter Configuration

The adapter (`tools/document-parser`) provides the contract expected by `@myrmidon/corpus` DocumentParser client:
- `POST /v1/parse`: accepts `{ submissionId, fileName, mimeType, title, parserVersion, contentBase64 }`.
- `GET /v1/parse/{jobId}`: returns `{ jobId, status: "pending" | "running" | "succeeded" | "failed", text, pages: [{ pageNumber, text }], error }`.
- **Chunk splitting**: splits document pages into blocks not exceeding 1500 characters (`CHUNK_MAX_CHARS=1500`), indexed sequentially with 1-based `pageNumber`.
- **Format protection**: rejects unsupported EPUB and FB2 formats (`.epub`, `.fb2`, `application/epub+zip`, `application/x-fictionbook+xml`) with error code `unsupported_format`.
- **Payload limits**: accepts request bodies up to 150 MiB (`MAX_BODY_BYTES=157286400`) to support base64 files up to 110 MiB; returns HTTP 413 `payload_too_large` if exceeded.
- **Idempotency**: retry-safe submission using `submissionId` — repeat requests return the existing job.

---

## Startup

```bash
# Start all corpus runtime services
docker compose -f docker/corpus/docker-compose.yml up -d
```

---

## Verification Commands (No Secrets)

### 1. DocumentParser Health
```bash
curl -s http://172.22.0.1:5001/health | jq .
```
Expected output:
```json
{
  "status": "ok",
  "service": "document-parser-adapter",
  "doclingServeUrl": "http://docling-serve:5001",
  "maxBodyBytes": 157286400,
  "chunkMaxChars": 1500
}
```

### 2. TEI Embeddings Verification (1024 Dimensions & 1000+ Batch)
```bash
# Verify single embedding dimensions
curl -s http://172.22.0.1:8090/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "BAAI/bge-m3", "input": ["тестовый документ"], "dimensions": 1024}' \
  | jq '{object: .object, count: (.data | length), dimensions: (.data[0].embedding | length)}'
```
Expected output:
```json
{
  "object": "list",
  "count": 1,
  "dimensions": 1024
}
```

```bash
# Verify batch >= 1000 items without 256 batch error
python3 -c '
import json, urllib.request
payload = json.dumps({"model": "BAAI/bge-m3", "input": ["chunk test"] * 1050, "dimensions": 1024}).encode("utf-8")
req = urllib.request.Request("http://172.22.0.1:8090/v1/embeddings", data=payload, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    print("Batch size:", len(data["data"]), "Dimensions:", len(data["data"][0]["embedding"]))
'
```
Expected output:
```text
Batch size: 1050 Dimensions: 1024
```

### 3. Parse Document Submission & Chunking (< 1500 chars)
```bash
# Submit document via POST /v1/parse
curl -s http://172.22.0.1:5001/v1/parse \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "test-sub-001",
    "fileName": "sample.txt",
    "mimeType": "text/plain",
    "contentBase64": "0J/RgNC40LLQtdGCINC80LjRgCEg0K3RgtC+INGC0LXRgdGC0L7QstGL0Lkg0LTQvtC60YPQvNC10L3RgiDQtNC70Y8gY29ycHVzLg=="
  }' | jq .
```
Expected output:
```json
{
  "jobId": "e304899c-30b1-4f36-a365-1f912e75e119",
  "status": "succeeded",
  "text": "Привет мир! Это тестовый документ для corpus.",
  "pages": [
    {
      "pageNumber": 1,
      "text": "Привет мир! Это тестовый документ для corpus."
    }
  ]
}
```

### 4. Unsupported Format Rejection (EPUB / FB2)
```bash
curl -s http://172.22.0.1:5001/v1/parse \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "test-sub-epub",
    "fileName": "book.epub",
    "mimeType": "application/epub+zip",
    "contentBase64": "ZXB1YmJ5dGVz"
  }' | jq .
```
Expected output:
```json
{
  "jobId": "f041d8e1-d419-4592-8096-7bb2a95c93d4",
  "status": "failed",
  "error": {
    "code": "unsupported_format",
    "message": "EPUB and FB2 formats are not supported by the document parser (detected fileName=book.epub, mimeType=application/epub+zip)"
  }
}
```
