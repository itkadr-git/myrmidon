# Document parser client (CORPUS-2.0)

The corpus module does not parse documents itself: PDFs and scans are parsed by a
separate service reached over HTTP. This client owns that call — the wire contract,
timeouts, retries and status polling — and is the only place in the module that knows
the service's paths. The response shapes are typed in [types.ts](types.ts); the failure
kinds are typed in [errors.ts](errors.ts).

## Endpoints

| Method | Path                  | Purpose                                     |
| ------ | --------------------- | ------------------------------------------- |
| `POST` | `/v1/parse`           | Submit a document for parsing               |
| `GET`  | `/v1/parse/{jobId}`   | Read the state of a submitted parse job     |
| `DELETE` | `/v1/parse/{jobId}` | Cancel a job nobody waits for any more (best effort, see below) |

Headers on every request:

- `content-type: application/json`
- `authorization: Bearer <module setting>` — only when the module is configured with a
  parser token. The token is a module setting and never appears in logs or comments.

## Request

```json
{
  "submissionId": "3f1c6b8e-…",
  "companyId": "…",
  "datasetId": "…",
  "documentId": "…",
  "fileName": "contract.pdf",
  "mimeType": "application/pdf",
  "contentBase64": "JVBERi0xLjQK…"
}
```

- `submissionId` is the idempotency key of the submission. The client generates a UUID for
  every call unless the caller passes `idempotencyKey`, so a retried submit that reaches the
  service twice yields one job, not two.
- `documentId` is optional: a parse may be submitted before the corpus document row exists.
- `contentBase64` is the raw document, base64-encoded. The client never sends the bytes any
  other way.
- `fileName` and `mimeType` are what the caller chose; the service decides whether it can
  parse the type and answers `4xx` when it cannot.

## Job

`POST` answers `2xx` with the accepted job, `GET` answers `200` with the job in its current
state. Both use one shape:

```json
{
  "jobId": "job-1",
  "status": "pending",
  "text": "…",
  "pages": [{ "pageNumber": 1, "text": "…" }],
  "error": { "code": "encrypted_pdf", "message": "…" }
}
```

| `status`    | Client behaviour                                                        |
| ----------- | ----------------------------------------------------------------------- |
| `pending`   | keep polling every `pollIntervalMs`; the wait is bounded by `queueTimeoutMs` |
| `running`   | keep polling every `pollIntervalMs`; given up on after `pollTimeoutMs` without progress (`progress.done` growing starts the count over), or after `maxRunMs` in all |
| `succeeded` | finish: `text` if the service sent it, otherwise the page texts joined by a blank line and ordered by `pageNumber` |
| `failed`    | finish with a permanent failure carrying `error.code` / `error.message` |

A `succeeded` job that carries neither `text` nor a non-empty page is a contract violation
(`invalid-response`), not an empty document.

## Failures

`parseDocument` does not throw for service failures: it returns
`{ ok: false, jobId, error }`. The caller decides what to do with the job, which is what
keeps a broken parser from crashing the worker.

| `kind`             | When                                                                  | `retryable` |
| ------------------ | --------------------------------------------------------------------- | ----------- |
| `unavailable`      | connection failure, `5xx`, `408`, `429`                               | yes         |
| `timeout`          | no answer within `timeoutMs`; the job ran `pollTimeoutMs` without progress or `maxRunMs` in all; or it did not start within `queueTimeoutMs` | yes |
| `rejected`         | `4xx` other than `408`/`429` — unsupported type, too large, bad token  | no          |
| `parse-failed`     | the service accepted the job and reported it cannot parse the document | no          |
| `invalid-response` | body does not match this contract, or the base URL/JSON is unusable    | no          |

`retryable` is the whole point of the split: the corpus work queue retries the retryable
kinds and fails the others for good, without reading message texts. A retryable failure
keeps `jobId` when the job was already created, so the retry can poll instead of resubmitting.

### Giving up on a job

The limit on a job (`pollTimeoutMs`, from the module setting `parserTimeoutMs`, up to two hours)
is the time it RUNS WITHOUT PROGRESS. The clock starts when a poll first reports the job `running`
and starts over every time `progress.done` (pages done) grows, so a scanned book that keeps turning
pages is never given up on after N minutes — only one that stops is. A format that has no pages
sends no progress and gets `pollTimeoutMs` from the start of its run. `maxRunMs` (six hours) is a
hard ceiling on a run that never ends. A document that waits in the service's queue behind others
does not use any of it — the service parses one document at a time, so the Nth document of a batch
would never fit otherwise. A job that goes back to `pending` (the service restarted) stops the run
clock and starts the queue clock (`queueTimeoutMs`, four hours, counted from the last time the job
was queued, so a service that never starts the job cannot hold a worker slot forever); the progress
count starts over when it runs again.

When `parseDocument` ends an attempt without a final state of the job (a timeout, an abort
by the caller, a poll that keeps failing) it sends `DELETE /v1/parse/{jobId}` before it returns.
Without it the service goes on parsing — a large scanned book for tens of minutes — for a client that
has left, and the next attempt waits behind it. The request is best effort: one try with a short
timeout, never retried, and its failure (`404`, `405` from a service older than the endpoint, no
answer) changes nothing in the outcome. `cancelJob(jobId, { submissionId })` is exported for callers
that drive the job themselves. A finished job is never cancelled: its result stays in the service
until its TTL, and a retry of the same document finds it.

Every request of an attempt after the submission — the polls and the cancel — carries the attempt's
`submissionId` in the `X-Submission-Id` header. A job is shared by all clients that submit the same
document, and the service uses the header to cancel it only when no other client still waits for
it (the answer is then `cancelled: false` and the job runs on). `cancelJob` without a
`submissionId` cancels whoever else waits.

Retries inside the client use the shared retry policy of the module (`attempts`,
exponential backoff with jitter) and apply to `unavailable` / `timeout` only. A call that
exhausts them returns the last error; the queue then schedules the next attempt of the job.

## Two surfaces, one client

`createHttpDocumentParser` is the `DocumentParser` port of the module: `parse(request)` takes
the port's `DocumentParseRequest` (document bytes or a source URI, content type, title,
parser version) and answers with the port's `DocumentParseResult` — the service's pages as
parsed blocks in reading order (`chunkIndex`, `content`, `pageNumber` in the block metadata),
or a single block when the service answers with plain text, plus `jobId`, `parserVersion` and
`pageCount` as metadata. Failure is **thrown** as a `DocumentParserError` carrying `retryable`,
because that is what the worker needs: a retryable failure becomes a failed job the queue
picks up again, a permanent one a failed job the queue does not retry.

`createDocumentParserClient` is the layer underneath and stays exported: it reports the same
failures as a typed outcome (`{ ok: false, error }`) instead of throwing, and exposes
`submitDocument` / `fetchJob` for callers that want to drive the job themselves. Nothing in
this package decides retry policy — it only reports whether a failure is worth retrying.

## Settings used by this client

| Option           | Default | Meaning                                                  |
| ---------------- | ------- | -------------------------------------------------------- |
| `baseUrl`        | —       | parser base URL, from the module settings                 |
| `apiKey`         | —       | bearer token, from the module settings                    |
| `timeoutMs`      | 30000   | per-request timeout (derived from `parserTimeoutMs` when only that is set, at most 120000) |
| `pollIntervalMs` | 500     | pause between status polls                                |
| `pollTimeoutMs`  | 120000  | how long a job may RUN WITHOUT PROGRESS (`progress.done` growing starts the count over; falls back to `parserTimeoutMs`) |
| `queueTimeoutMs` | 14400000 | how long a job may wait in the service's queue before it runs (counted from the last time it was queued) |
| `maxRunMs`       | 21600000 | hard ceiling on one run, progress or not |
| `retry`          | shared  | attempts and backoff of the client's own retries          |

Wiring these to interface settings and environment variables is outside this package.

## Tests

[document-parser-client.myrmidon.test.ts](document-parser-client.myrmidon.test.ts) runs the
client against an in-process `node:http` server and covers the accepted path, polling, the
retry of `5xx`, permanent `4xx`, both timeouts, a malformed body and an unreachable service, and
the time limit that counts running time without progress (a long wait in the queue does not fail a
job, a book that keeps progressing is not given up on), the queue clock that starts over when a job
is queued again, the `X-Submission-Id` header, and the cancel request after a timeout, an abort and a
broken poll.
[http-document-parser.myrmidon.test.ts](http-document-parser.myrmidon.test.ts) runs the same
way for the port adapter: byte and source-URI submissions, the wire body, one block per page
in reading order, a retried `5xx`, a refused request, a failed job and an unreachable
service. No live network, no keys.